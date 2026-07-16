export { QjsPeer };
import * as os from 'os';
import { TextEncoder, TextDecoder } from './EncodeDecode.mjs';
import { PeerConnection } from './dc.so';
import { PriorityChannel } from './priorityChannel.mjs';

const enc = new TextEncoder;

function encodeMsg( { type, data = {} } ){
	const text = data instanceof Uint8Array ? 0 : 1;
	const _data = text == 1 ? enc.encode( JSON.stringify( data ) ) : data;
	const a = new Uint8Array( 1 + type.length + _data.length );
	a[ 0 ] = ( text << 7 ) | ( type.length & 0x7F );
	a.set( enc.encode( type ), 1 );
	a.set( _data, 1 + type.length );
	return a;
}

class QjsPeer{
	priorityChannel;
	typeToQueue = () => { throw( 'QjsPeer.typeToQueue not set' ); };
	initiator;
	agent;

	listeners = {
		sdp(){},
		connect(){},
		data(){},
		disconnect(){},
		signal(){}
	};

	listenerNames = Object.keys( this.listeners );

	constructor( { initiator, label } = { initiator: false, label: 'not_set' } ){
		this.agent = new PeerConnection( {
			stun_host: "stun.l.google.com",
			stun_port: 19302,
			initiator,
			label
		} );

		this.initiator = initiator;
		//console.log( `this.agent.getBufferedAmount: ${ this.agent?.getBufferedAmount }` );

		this.agent.dcOpen = () => { this.listeners.connect(); };
		dcMsgHandler( this );
	}

	close(){
		this.agent.close();
	}

	createQueues( queuesOrder ){
		this.priorityChannel = new PriorityChannel( {
			sendFn: ( item ) => { this.agent.sendBuf( encodeMsg( item ).buffer ); },
			getHwFn: () => { return this.agent.getBufferedAmount(); },
			queuesOrder
		} );
	}

	on( event, handler ){
		if( this.listenerNames.includes( event ) ) this.listeners[ event ] = handler;
	}

	send( { type, data } ){
		this.priorityChannel.send( this.typeToQueue( type ), { type, data } );
		this.priorityChannel.pump;
	};

	signal( msg ){
		switch( msg.type ){
			case 'offer':
				this.agent.connect( msg.sdp );
				break;

			case 'answer':
				this.agent.setRemoteDescription( msg.sdp );
				break;

			default:
		}
	};

	peerName = '';
	myName = '';
}

// -----------------------------------------------------------------------------
// dcMsgHandler
// Handle messages from libdatachannel. These are about the state of the datachannel
// and data received over the channel frome the peer
// ---------------------------------------------------------------------------

function dcMsgHandler( qjspeer ) {
	const dec = new TextDecoder();
	os.setReadHandler( qjspeer.agent.fd, () => {
		const msg = readMsg( qjspeer.agent.fd );
		switch ( msg.type ) {
			case PeerConnection.MSG_SDP:
				qjspeer.listeners.sdp( dec.decode( msg.data ) );
				break;

			case PeerConnection.MSG_DC_OPEN:
				// DataChannel is open — safe to send now
				//console.log( `datachannel open: ${ dec.decode( msg.data ) }` );
				qjspeer.agent.dcOpen();
				break;

			case PeerConnection.MSG_DC_CLOSE:
				console.log( `datachannel closed: ${ dec.decode( msg.data ) }` );
				break;

			case PeerConnection.MSG_CONNECTED:
				// ICE connected — DataChannel may not be open yet; wait for MSG_DC_OPEN
				console.log( 'ICE connected' );
				break;

			case PeerConnection.MSG_DISCONNECTED:
				os.setReadHandler( qjspeer.agent.fd, null );
				qjspeer.listeners.disconnect();
				break;

			case PeerConnection.MSG_DATA: // message from peer
				const [ text, typeLength ] = [ msg.data[0] >> 7, msg.data[0] & 0x7F ];
				const type = dec.decode( msg.data.slice( 1, 1 + typeLength ) );
				const data = text == 1
					? JSON.parse( dec.decode( msg.data.slice( 1 + typeLength ) ) )
					: msg.data.slice( 1 + typeLength );
				qjspeer.listeners.data( { type, data } );
				break;

			case PeerConnection.MSG_BUFFERED_LOW: // datachannel ready for more messages
				console.log( 'MSG_BUFFERED_LOW' );
				qjspeer.pump();
				break;

			default:
				break;
		}
	} );
}

// ---------------------------------------------------------------------------
// readExact, readMsg
// Helper for dcMsgHandler
// ---------------------------------------------------------------------------

function readExact( fd, buf, length ) {
	let total = 0;
	while ( total < length ) {
		const n = os.read( fd, buf, total, length - total );
		if ( n <= 0 ) throw ( { code: 'eof or read error' } );
		total += n;
	}
	return total;
}

function readMsg( fd ) {
	const headerBuf = new Uint8Array( 5 );
	readExact( fd, headerBuf.buffer, 5 );
	const type = headerBuf[0];
	const payloadLength = new DataView( headerBuf.buffer ).getInt32( 1, false );

	switch ( type ) {
		case PeerConnection.MSG_SDP:
		case PeerConnection.MSG_DATA:
		case PeerConnection.MSG_DC_OPEN:
		case PeerConnection.MSG_DC_CLOSE: {
			const payloadBuf = new Uint8Array( payloadLength );
			if ( payloadLength > 0 ) readExact( fd, payloadBuf.buffer, payloadLength );
			return { type, data: payloadBuf, length: payloadLength };
		}
		default:
			return { type };
	}
}


