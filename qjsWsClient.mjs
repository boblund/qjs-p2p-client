export { newWsClient };

import * as os from 'os';
import { Client } from 'socket.so';
import { parseUrl } from './parseUrl.mjs';
import { TextEncoder, TextDecoder } from './EncodeDecode.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

function wsFrame( opcode, payload, masked = false ) {
	const payloadLen = payload.length;
	const FIN = 0x80;
	const MASK = masked ? 0x80 : 0x00;
	const headerLen = ( payloadLen < 126
		? 2
		: payloadLen <= 0xFFFF
			? 4
			: 10
	) + ( masked ? 4 : 0 );

	const buf = new Uint8Array( headerLen + payloadLen );
	let offset = 0;

	buf[offset++] = FIN | opcode;

	if ( payloadLen < 126 ) {
		buf[offset++] = MASK | payloadLen;
	} else if ( payloadLen <= 0xFFFF ) {
		buf[offset++] = MASK | 126;
		buf[offset++] = ( payloadLen >> 8 ) & 0xFF;
		buf[offset++] = payloadLen & 0xFF;
	} else {
		buf[offset++] = MASK | 127;
		buf[offset++] = 0; buf[offset++] = 0; buf[offset++] = 0; buf[offset++] = 0;
		buf[offset++] = ( payloadLen >>> 24 ) & 0xFF;
		buf[offset++] = ( payloadLen >>> 16 ) & 0xFF;
		buf[offset++] = ( payloadLen >>> 8 )  & 0xFF;
		buf[offset++] = payloadLen & 0xFF;
	}

	if( masked ){
		const maskKey = [
			( Math.random() * 256 ) | 0,
			( Math.random() * 256 ) | 0,
			( Math.random() * 256 ) | 0,
			( Math.random() * 256 ) | 0
		];
		buf[offset++] = maskKey[0];
		buf[offset++] = maskKey[1];
		buf[offset++] = maskKey[2];
		buf[offset++] = maskKey[3];

		for ( let i = 0; i < payloadLen; i++ ) {
			buf[offset++] = payload[i] ^ maskKey[i % 4];
		}
	} else {
		buf.set( payload, offset );
	}

	return buf;
}

// ws client frame builder
function old_buildMaskedFrame( opcode, payload ) {
	const payloadLen = payload.length;

	let headerLen;
	if ( payloadLen < 126 )          headerLen = 6;
	else if ( payloadLen <= 0xFFFF ) headerLen = 8;
	else                              headerLen = 14;

	const buf = new Uint8Array( headerLen + payloadLen );
	let offset = 0;

	buf[offset++] = 0x80 | opcode;

	if ( payloadLen < 126 ) {
		buf[offset++] = 0x80 | payloadLen;
	} else if ( payloadLen <= 0xFFFF ) {
		buf[offset++] = 0x80 | 126;
		buf[offset++] = ( payloadLen >> 8 ) & 0xFF;
		buf[offset++] = payloadLen & 0xFF;
	} else {
		buf[offset++] = 0x80 | 127;
		buf[offset++] = 0; buf[offset++] = 0; buf[offset++] = 0; buf[offset++] = 0;
		buf[offset++] = ( payloadLen >>> 24 ) & 0xFF;
		buf[offset++] = ( payloadLen >>> 16 ) & 0xFF;
		buf[offset++] = ( payloadLen >>> 8 )  & 0xFF;
		buf[offset++] = payloadLen & 0xFF;
	}

	const maskKey = [
		( Math.random() * 256 ) | 0,
		( Math.random() * 256 ) | 0,
		( Math.random() * 256 ) | 0,
		( Math.random() * 256 ) | 0
	];
	buf[offset++] = maskKey[0];
	buf[offset++] = maskKey[1];
	buf[offset++] = maskKey[2];
	buf[offset++] = maskKey[3];

	for ( let i = 0; i < payloadLen; i++ ) {
		buf[offset++] = payload[i] ^ maskKey[i % 4];
	}

	return buf;
}

class WsClient {
	#listenerFuncs = {
		close(){},
		message(){},
		ping(){},
		pong(){},
	};

	#listenerNames = Object.keys( this.#listenerFuncs );
	#fds = undefined;
	#socket;

	constructor( fds, socket ){
		this.#fds = fds;
		this.#socket = socket; // keeps socket alive while the WsClient instance exists
		let continueOpcode = 0, chunks = [], totalLength = 0, msg;
		let readBuf = new Uint8Array( 4096 );

		os.setReadHandler( this.#fds[ 0 ], () => {
			const n = os.read( this.#fds[ 0 ], readBuf.buffer, 0, readBuf.length );

			if( n == 0 || ( n == 1 && readBuf[ 0 ] == 0 ) ){
				this.#listenerFuncs.close( { code: 1006, reason: 'server abnormal close' } );
				this.close();
				return;
			}

			const fin = ( readBuf[ 0 ] >> 7 ) && 0x1;
			const opcode = readBuf[ 0 ] & 0xf;

			let ofs = 2;
			let len = readBuf[1] & 0x7F;
			if( len == 126 ){
				ofs = 4;
				len = ( readBuf[2] << 8 ) | readBuf[3];
			} else if ( len === 127 ) {
				if( readBuf.length < ofs + 8 ) return null;

				// top 4 bytes should be 0 for realistic sizes; if not, payload is >4GB (reject/handle separately)
				const high = ( readBuf[ofs] << 24 ) | ( readBuf[ofs + 1] << 16 ) | ( readBuf[ofs + 2] << 8 ) | readBuf[ofs + 3];
				if ( high !== 0 ) throw new Error( 'Payload too large' );

				len = ( ( readBuf[ofs + 4] << 24 ) | ( readBuf[ofs + 5] << 16 ) | ( readBuf[ofs + 6] << 8 ) | readBuf[ofs + 7] ) >>> 0;
				ofs += 8;
			}

			if( ( continueOpcode == 0 &&  opcode == 0 )
					|| ( continueOpcode != 0 &&  opcode != 0 ) ){
				continueOpcode = 0, msg = '';
				this.close( 1002 ); // protocol error
				return;
			}

			const isControl = opcode >= 0x8;
			if( isControl && ( !fin || len > 125 ) ){
				this.close( 1002 ); // protocol error: fragmented or oversized control frame
				return;
			}

			switch( opcode ){
				case 0:
				case 1:
				case 2:
					if( opcode == 1 || continueOpcode == 1 ){
						chunks.push( String.fromCharCode.apply( null, readBuf.slice( ofs, ofs + len ) ) );
					} else {
						totalLength += len;
						chunks.push( new Uint8Array( readBuf.slice( ofs, ofs + len ) ) );
					}

					if( fin == 1 ){
						if( opcode == 1 || continueOpcode == 1 ){
							msg = chunks.join( "" );
							this.#listenerFuncs.message( msg );
						} else {
							const result = new Uint8Array( totalLength );
							let offset = 0;
							for ( const c of chunks ) { result.set( c, offset ); offset += c.byteLength; }
							this.#listenerFuncs.message( result );
						}
						totalLength = 0;
						msg = '';
						chunks = [];
						continueOpcode = 0; // may be final frame of multi-frame msg
					}else{
						if( opcode != 0 ) continueOpcode = opcode; // 1st frame of multi-frame msg
					}
					break;

				case 8:
					let statusCode = 1005; // "No Status Received" per RFC 6455, the correct default
					let reason = '';

					if( len >= 2 ){
						statusCode = ( readBuf[ofs] << 8 ) | readBuf[ofs + 1];
						reason = new TextDecoder().decode( readBuf.slice( ofs + 2, ofs + len ) );
					}

					this.#listenerFuncs.close( { code: r.statusCode, message: r.reason } );
					this.close();
					msg = '';
					break;

				case 9:
					this.#listenerFuncs.ping();
					break;

				case 10:
					this.#listenerFuncs.pong();
					break;

				default:
			}
		} );
	};

	close( code, reason ) {
		const reasonBytes = reason ? enc.encode( reason ).slice( 0, 123 ) : new Uint8Array( 0 ); // 123 max length
		const payload = new Uint8Array( 2 + reasonBytes.length );
		payload[0] = ( code >> 8 ) & 0xFF;
		payload[1] = code & 0xFF;
		payload.set( reasonBytes, 2 );
		const buf = wsFrame( 0x8, payload, true );
		os.write( this.#fds[1], buf.buffer, 0, buf.byteLength );
		this.end();
	}

	on( event, func ){ if( this.#listenerNames.includes( event ) ) this.#listenerFuncs[ event] = func; };

	ping() {
		const buf = wsFrame( 0x9, new Uint8Array( 0 ), true );
		os.write( this.#fds[1], buf.buffer, 0, buf.byteLength );
	}

	send( message ) {
		const payload = enc.encode( message );
		const buf = wsFrame( typeof message == 'string' ? 0x1 : 0x2, payload, true );
		os.write( this.#fds[1], buf.buffer, 0, buf.byteLength );
	}

	end(){
		os.setReadHandler( this.#fds[ 0 ], null );
		os.close( this.#fds[ 0 ] ); os.close( this.#fds[ 1 ] );
	};
}

function newWsClient( url, token = undefined ){
	const { protocol, addr, port, path } = parseUrl( url );
	const host = addr;
	const wsPath = path ?? '/';
	const req = [
		`GET ${ wsPath } HTTP/1.1`,
		`Host: ${ host }`,
		"Connection: Upgrade",
		"Upgrade: websocket",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: IS0tZXhhbXBsZS5haS0tIQ==",
		"Origin: localhost",
		`token: ${ token }`,
		"",  // blank line = end of headers
		""   // produces trailing \r\n
	].join( "\r\n" );

	let socket = new Client();

	return new Promise( ( res, rej ) => {
		let readBuf = new Uint8Array( 4096 );
		let { protocol, addr, port } = parseUrl( url );
		let fds = socket.connect( {
			port: protocol == 'wss' ? 443 : 80,
			host: addr,
			tls: protocol == 'wss' ? true : false
		} );

		if( fds === undefined ){
			console.log( 'socket.connect failed' );
			// rej
		}

		os.setReadHandler( fds[ 0 ], () => {
			const n = os.read( fds[ 0 ], readBuf.buffer, 0, readBuf.length );
			if( n === 0 || ( n === 1 && readBuf[0] === 0 ) ){
				os.setReadHandler( fds[ 0 ], null );
				// rej
				return;
			}
			if ( n > 0 ){
				const chunk = readBuf.slice( 0, n );
				const chunkText = dec.decode( chunk ).split( '\r\n' );
				const [ , code, reason ] = chunkText[0].split( ' ' );
				if(  code == '101' ){
					console.log( 'ws upgrade' );
					res( new WsClient( fds, socket ) );
				} else {
					os.setReadHandler( fds[ 0 ], null );
					rej( { code, reason, message: chunkText[ chunkText.length - 1 ] } );
				}
				return;
			}
			os.close( fds[ 0 ] );
			os.setReadHandler( fds[ 0 ], null );
		} );

		let encoded = enc.encode( req );
		let buf = encoded.slice().buffer;
		os.write( fds[ 1 ], buf, 0, buf.byteLength );
	} );
};
