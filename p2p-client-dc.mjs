import * as std from 'std';
import * as os from 'os';
import { newWsClient } from './qjsWsClient.mjs';
import { refreshIdToken } from './cognito.mjs';
import { TextDecoder, fromBase64 } from './EncodeDecode.mjs';
import { QjsPeer } from './qjsPeer.mjs';

const dec = new TextDecoder;

function makePeer( { initiator = false, label = '', peerName } = {} ){
	const peer = new QjsPeer( { initiator, label } );
	peer.createQueues( [ 'cmd', 'chunk', 'transfer' ] );
	peer.typeToQueue = function( type ){
		if( ![ 'result', 'eof', 'error', 'ready', 'transfer', 'chunk' ].includes( type ) ) throw( `error unknown peer msg type: ${ type }` );
		const queue = type == 'transfer'
			? 'transfer'
			: type == 'chunk'
				? 'chunk'
				: 'cmd';
		return queue;
	};
	peer.priorityChannel.addQueue( 'cmd' );
	peer.priorityChannel.addQueue( 'transfer' );
	peer.peerName = peerName;
	peer.myName = JSON.parse(
		String.fromCharCode.apply( null, fromBase64( config.token.split( '.' )[1] ) )
	)['custom:brume_name'];
	return peer;
}

// ---------------------------------------------------------------------------
// parse cmd line args, get AWS ws credentials, determine if sender or receiver
// ---------------------------------------------------------------------------

if ( scriptArgs.length < 2 || scriptArgs.length > 3 ) {
	console.log( `Usage: ${ scriptArgs[0] } pathToConfigFile [ receiver_name ]` );
	std.exit( 1 );
}

let config, wsc;
try {
	config = JSON.parse( std.loadFile( scriptArgs[1] ) );
} catch ( e ) {
	console.log( `error reading ${ scriptArgs[1] }: ${ e }` );
	std.exit( 1 );
}

const receiver = scriptArgs.length === 2 ? undefined : scriptArgs[2];

// -----------------------------------------------------------------------------
// start the app, refresh the AWS ws ID Token if necessary
// -----------------------------------------------------------------------------

try {
	await start();
} catch ( e ) {
	console.log( `ws connect error:`, e );
	if ( e.code === '401' ) {
		try {
			config.token = await refreshIdToken( config.RefreshToken );
			await start();
			const configFile = std.open( scriptArgs[1], 'w' );
			configFile.puts( JSON.stringify( config, 2, null ) );
			configFile.close();
		} catch ( e ) {
			console.log( `post refreshIdToken ws connect error:`, e );
		}
	}
}

// -----------------------------------------------------------------------------
// start
// connect to the ws signaling server, create a peer if sender (initiator),
// create datachannel to receiver peer, set ws message handler
// -----------------------------------------------------------------------------

async function start() {
	let peer = undefined;
	wsc = await newWsClient( config.url, config.token );
	console.log( `ws connected` );

	wsc.on( 'close', function ( reason ) {
		console.log( `wsc.on close: ${ JSON.stringify( reason ) }` );
	} );

	wsc.on( 'message', ( message ) => {
		const msg = JSON.parse( message );
		const msgType = msg.type ? msg.type : msg?.data?.type;
		switch ( msgType ) {
			case 'answer':
				peer.signal( msg );
				break;

			case 'offer':
				peer = makePeer( { label: 'data', peerName: msg.from } );
				peer.on( 'data', ( msg ) => { peerMsgHandler( peer, msg ); } );
				peer.on( 'sdp', ( sdp ) => {
					wsc.send( JSON.stringify( {
						action: 'send',
						to: peer.peerName,
						data: { type: 'answer', sdp }
					} ) );
				} );
				peer.signal( msg ); // sets the remote sdp and triggers answer + ICE gathering
				peer.on( 'disconnect', () => {
					console.log( 'peer disconnected' );
					std.exit();
				} );

				break;

			case 'peerError':
				const { type, code, peerUsername } = JSON.parse( message ).data;
				console.log( type, code, peerUsername );
				break;

			default:
				console.log( `unknown ws message: ${ message }` );
				break;
		}
	} );

	if ( receiver !== undefined ) {
		peer = makePeer( { initiator: true, label: 'data', peerName: receiver } );
		peer.on( 'data', ( msg ) => { peerMsgHandler( peer, msg ); } );
		peer.on( 'sdp', ( sdp ) => {
			wsc.send( JSON.stringify( { action: 'send', to: peer.peerName, data: { type: 'offer', sdp } } ) );
		} );

		peer.on( 'connect', () => {
			peer.send( { type: 'transfer', data: './juice_module.c' } );
			peer.priorityChannel.block( 'transfer', true );
			peer.send( { type: 'transfer', data: './EncodeDecode.mjs' } );
		} );

		peer.on( 'disconnect', () => {
			console.log( 'peer disconnected' );
			std.exit();
		} );
	}
}

// ---------------------------------------------------------------------------
// peerMsgHandler
// Peer-to-peer datachannel messages handler where peer app logic lives.
// Handles peer-to-peer commands and file transfer
// ---------------------------------------------------------------------------

function peerMsgHandler( peer, { type, data } ){
	switch( type ){
		case 'cmd':
			// process command
			break;

		case 'transfer': {
			const fd = os.open( `${ data }-received`, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644 );
			if( fd < 0 ){
				peer.send( { type: 'result', data: `${ os.strerr( fd ) }: opening ${ data }-received for 'w'` } );
				break;
			}
			peer.receiveFileObj = { fileName: `${ data }-received`, fd };
			console.log( '[Receiving file] starting:', peer.receiveFileObj.fileName );
			peer.send( { type: 'ready', data } );
			break;
		}

		case 'ready':
			{
				let fd = os.open( data, os.O_RDONLY );
				if( fd < 0 ){
					console.log( { error: `error ${ os.strerr( fd ) }: opening ${ data } for reading` } );
					break;
				}
				console.log( '[Sending file] starting:', data );
				let offset = 0;
				let buf = new Uint8Array( 4096 );
				peer.priorityChannel.addQueue( 'chunk', {
					ready: () => { return fd != -1; },
					next: () => {
						let n = os.read( fd, buf.buffer, 0, buf.length );
						if ( n <= 0 ){
							os.close( fd );
							fd = -1; offset = 0;
							console.log( '[Sending file] ending:', data );
							peer.priorityChannel.deleteQueue( 'chunk' );
							return { type: n == 0 ? 'eof' : 'error' };
						} else {
							offset += n;
							return { type: 'chunk', data: buf.slice( 0, n ) };
						}
					}
				} );
				peer.priorityChannel.pump();
			}
			break;

		case 'chunk':
			os.write( peer.receiveFileObj.fd, data.buffer, 0, data.length );
			break;

		case 'eof':
		case 'error':
			console.log( `[Receiving file] ${ type == 'eof' ? 'finished' : 'sender error' }: ${ peer.receiveFileObj.fileName }` );
			os.close( peer.receiveFileObj.fd );
			if( type == 'error' ) os.remove( peer.receiveFileObj.fileName );
			if( type == 'eof' ){
				const status = 'success'; // or not if check sizes/checksums don't match
				peer.send( { type: 'result', data: { fileName: peer.receiveFileObj.fileName, status } } );
			}

			break;

		case 'result':
			console.log( 'result:', data );
			peer.priorityChannel.block( 'transfer', false );
			peer.priorityChannel.pump();
			break;

		default:
	}
}
