//https://gist.github.com/gabonator/d7b813dd33e5413c29661f42e7472437
import * as std from 'std';
import * as os from 'os';
import { Juice } from './juice.so';
import { newWsClient } from './qjsWsClient.mjs';
import { refreshIdToken } from './cognito.mjs';
import { TextEncoder, TextDecoder, fromBase64 } from './EncodeDecode.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Logic to exchange SDP messages with peer via Brume signaling server
function wsMsgHandler( _msg, agent, errorCb = () => {} ){
	const msg = JSON.parse( _msg );
	const type = msg?.type ? msg.type : msg?.data?.type;
	switch( type ){
		case 'answer':
			agent.setRemoteDescription( msg.sdp );
			break;

		case 'offer':
			agent = new Juice( { stun_host: "stun.l.google.com", stun_port: 19302 } );
			agent.peerName = msg.from;
			agent.myName = JSON.parse( String.fromCharCode.apply( null, fromBase64( config.token.split( '.' )[1] ) ) )[ 'custom:brume_name' ];
			agent.connect( msg.sdp );
			juiceMSgHandler( agent );
			break;

		case 'peerError':
			console.log( type, msg.data.code, msg.data.peerUsername );
			errorCb( msg.data );
			return;

		default:
			console.log( `unknown ws message: ${ _msg }` );
			break;
	}
}

// Logic to exchange ICE messages with peer via qjsJuice
function juiceMSgHandler( agent ){
	os.setReadHandler( agent.fd, () => {
		const msg = readMsg( agent.fd );
		switch ( msg.type ) {
			case Juice.MSG_SDP:
				wsc.send( JSON.stringify( {
					action: 'send',
					to: agent.peerName,
					data: { type: agent.initiator ? 'offer' : 'answer', sdp: dec.decode( msg.data ) } } ) );
				break;

			case Juice.MSG_CONNECTED:
				agent.send( enc.encode( `hello from ${ agent.myName }` ).buffer );
				break;

			case Juice.MSG_DISCONNECTED:
				console.log( 'peer disconnected' );
				std.exit();
				break;

			case Juice.MSG_DATA:
				console.log( `message from ${ agent.peerName }: ${ dec.decode( msg.data ) }` );
				break;

			case Juice.MSG_CLOSE:
				os.setReadHandler( agent.fd, null );
				break;

			default:
		}
	} );
}

// qjsJuice helper function
function readMsg( fd ){
	let readBuf = new Uint8Array( 5 );
	let n = os.read( fd, readBuf.buffer, 0, 5 );
	if( n != 5 ) throw( { code: 'bad header' } );
	const type = readBuf[ 0 ];
	switch( type ){
		case Juice.MSG_SDP:
		case Juice.MSG_DATA:
			const payloadLength = new DataView( readBuf.buffer ).getInt32( 1, false );
			readBuf = new Uint8Array( payloadLength );
			let totalBytes = 0;
			while( totalBytes < payloadLength ){
				totalBytes += os.read( fd, readBuf.buffer, totalBytes, readBuf.length - totalBytes );
			}
			return { type, data: readBuf, length: totalBytes };

		default:
			return { type };
	}
}

// Boilerplate that shouldn't change based on app logic
if( scriptArgs.length < 2 || scriptArgs.length > 3 ){
	console.log( `Usage: ${ scriptArgs[ 0 ] } pathToConfigFile [ receiver_name ]` );
	std.exit( 1 );
}

let config, wsc;
try{
	config = JSON.parse( std.loadFile( scriptArgs[ 1 ] ) );
} catch( e ){
	console.log( `error reading ${ scriptArgs[ 1 ] }: ${ e }` );
	std.exit( 1 );
}

const receiver = scriptArgs.length === 2 ? undefined : scriptArgs[ 2 ];

async function start(){
	let agent = undefined;
	wsc = await newWsClient( config.url, config.token );
	console.log( `ws connected` );

	wsc.on( 'close', function( reason ){
		console.log( `wsc.on close: ${ JSON.stringify( reason ) }` );
	} );

	if( receiver !== undefined ){
		agent = new Juice( { stun_host: "stun.l.google.com", stun_port: 19302, initiator: true } );
		agent.peerName = receiver;
		agent.myName = JSON.parse( String.fromCharCode.apply( null, fromBase64( config.token.split( '.' )[1] ) ) )[ 'custom:brume_name' ];
		juiceMSgHandler( agent );
	}

	wsc.on( 'message', ( message ) => { wsMsgHandler( message, agent, ( data ) =>{ wsc.close(); } ); } );
}

try{
	await start();
} catch( e ){
	console.log( `ws connect error:`, e );
	if( e.code === '401' ){
		try{
			config.token = await refreshIdToken( config.RefreshToken );
			await start();
			const configFile = std.open( scriptArgs[ 1 ], 'w' );
			configFile.puts( JSON.stringify( config, 2, null ) );
			configFile.close();
		} catch( e ){
			console.log( `post refreshIdToken ws connect error:`, e );
		};
	}
};
