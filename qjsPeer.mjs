export { QjsPeer };
import * as os from 'os';
import { TextEncoder, TextDecoder } from './EncodeDecode.mjs';
import { PeerConnection } from './dc.so';

const enc = new TextEncoder;

function encodeMsg( { type, data = {} } ){
	const _data = data instanceof Uint8Array ? data : enc.encode( JSON.stringify( data ) );
	const a = new Uint8Array( 1 + type.length + _data.length );
	a[ 0 ] = type.length;
	a.set( enc.encode( type ), 1 );
	a.set( _data, 1 + a[ 0 ] );
	return a;
}

class QjsPeer{
	static HIGH_WATER_MARK = 64 * 1024;
	static LOW_WATER_MAKE = 16 * 104;

	controlMsgQueue = [];
	fileSendQueue = [];
	sendFileObj = {};
	pumping = false;
	buf = new Uint8Array( 4096 );
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

	pump(){
		if( this.pumping ) return;
		this.pumping = true;

		while ( this.agent.getBufferedAmount() < QjsPeer.HIGH_WATER_MARK
			&& ( this.controlMsgQueue.length > 0 || this.sendFileObj.fd > -1 || this.fileSendQueue.length > 0 ) ) {
			if( this.controlMsgQueue.length > 0 ){
				const { type, data } = this.controlMsgQueue.shift();
				this.agent.sendBuf( encodeMsg( { type, data } ).buffer );
				continue;
			}

			if( this?.sendFileObj?.fd > -1 ){
				// send chunks of existing file transfer next
				let n = os.read( this.sendFileObj.fd, this.buf.buffer, 0, this.buf.length );
				if ( n <= 0 ){
					this.agent.sendBuf( encodeMsg( { type: n == 0 ? 'eof' : 'error' } ).buffer );
					os.close( this.sendFileObj.fd );
					this.sendFileObj.fd = -1;
					this.sendFileObj.offset = 0;
					continue;
				}
				this.agent.sendBuf( encodeMsg( { type: 'chunk', data: this.buf.slice( 0, n ) } ).buffer );
				this.sendFileObj.offset += n;
				continue;
			}

			if( this.fileSendQueue.length > 0 ){
				const { data: fileName, resultCb } = this.fileSendQueue.shift();
				this.sendFileObj = { fileName, resultCb, fd: -1, offset: 0 };
				this.agent.sendBuf( encodeMsg( { type: 'file', data: fileName } ).buffer );
				console.log( `[Send file] starting: ${ this.sendFileObj.fileName }` );
				continue;
			}
		}

		this.pumping = false;
	};

	constructor( { initiator, label } = { initiator: false, label: 'not_set' } ){
		this.agent = new PeerConnection( {
			stun_host: "stun.l.google.com",
			stun_port: 19302,
			initiator,
			label
		} );

		this.initiator = initiator;

		this.agent.dcOpen = () => { this.listeners.connect(); };
		dcMsgHandler( this );
	}

	on( event, handler ){
		if( this.listenerNames.includes( event ) ) this.listeners[ event ] = handler;
	}

	send( { type, data }, resultCb = undefined ){
		if( type !== 'file' ){
			this.controlMsgQueue.push( { type, data } );
		} else {
			this.fileSendQueue.push( { data, resultCb } );
		}
		this.pump();
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
				qjspeer.listeners.data( msg );
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


