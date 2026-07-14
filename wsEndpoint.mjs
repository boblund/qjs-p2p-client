export { WsEndpoint };

import * as os from 'os';
import { TextEncoder, TextDecoder } from './EncodeDecode.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_PAYLOAD = 1024 * 1000;

function concatUint8( a, b ){
	const r = new Uint8Array( a.length + b.length );
	r.set( a, 0 );
	r.set( b, a.length );
	return r;
}

function closeFrame( code, reason, masked ){
	const payload = new Uint8Array( 2 + reason.length );
	payload[0] = ( code >> 8 ) & 0xFF;
	payload[1] = code & 0xFF;
	payload.set( reason, 2 );
	return wsFrame( 0x8, payload, masked );
}

function closeTcp( fds ){
	os.setReadHandler( fds[ 0 ], null );
	os.close( fds[ 0 ] ); os.close( fds[ 1 ] );
	fds[ 0 ] = fds[ 1 ] = -1;
}

function wsFrame( opcode, payload, masked ) {
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

class WsEndpoint {
	#listenerFuncs = {
		close(){},
		message(){},
		pong(){},
	};

	#listenerNames = Object.keys( this.#listenerFuncs );
	#fds = undefined;
	#socket;
	#role;
	#closing = false;
	#closeTimeout;

	constructor( fds, socket, role ){
		this.#fds = fds;
		this.#socket = socket; // keeps socket alive while the WsEndpoint instance exists
		this.#role = role;
		let continueOpcode = 0, chunks = [], totalLength = 0, msg;

		let readBuf = new Uint8Array( 4096 );
		let buf = new Uint8Array( 0 );
		os.setReadHandler( this.#fds[ 0 ], () => {
			const n = os.read( this.#fds[ 0 ], readBuf.buffer, 0, readBuf.length );

			if( n <= 0 || ( n == 1 && readBuf[ 0 ] == 0 ) ){
				console.log( `wsEndpoint closing: ${ this.#closing }, n: ${ n }` );
				if( this.#closing ){
					closeTcp( this.#fds );
					this.#closing = false;
					if( this.#role == 'client' ){
						os.clearTimeout( this.#closeTimeout );
						this.#closeTimeout = undefined;
					} else {
						this.#listenerFuncs.close( { code: 1006, reason: 'Abnormal closure' } );
					}
				} else {
					closeTcp( this.#fds );
					this.#listenerFuncs.close( n == 1
						? { code: 1001, reason: 'Going away' } //qjs socket server behavior
						: { code: 1006, reason: 'Abnormal closure' }
					);
				}
				return;
			}

			let opcode, fin, ofs, len, masked;
			buf = concatUint8( buf, readBuf.slice( 0, n ) );
			while( true ){
				if ( buf.length < 2 ) return;

				fin = ( buf[ 0 ] >> 7 ) && 0x1;
				opcode = buf[ 0 ] & 0xF;
				masked = Boolean( buf[1] & 0x80 );
				len = buf[1] & 0x7F;
				ofs = 2;
				if( len == 126 ){
					if( buf.length < ofs + 2 ) return;
					len = ( buf[ofs] << 8 ) | buf[ofs + 1];
					ofs += 2;
				} else if ( len === 127 ) {
					if( buf.length < ofs + 8 ) return;
					// top 4 bytes should be 0 for realistic sizes; if not, payload is >4GB (reject/handle separately)
					const high = ( buf[ofs] << 24 ) | ( buf[ofs + 1] << 16 ) | ( buf[ofs + 2] << 8 ) | buf[ofs + 3];
					if ( high !== 0 ){
						const frame = closeFrame( 1009, 'Payload too large' );
						os.write( fds[ 1 ], frame.buffer, 0, frame.length );
						this.#closing= true;
						this.#closeTimeout = setTimeout( () => {
							closeTcp( fds );
							this.#closing= false;
							this.#closeTimeout = undefined;
						}, 5000 );
						return;
					}

					len = (
						( buf[ofs + 4] << 24 ) |
						( buf[ofs + 5] << 16 ) |
						( buf[ofs + 6] << 8 ) |
						buf[ofs + 7]
					) >>> 0;

					ofs += 8;
				}

				let maskingKey = null;
				if ( masked ) {
					if ( buf.length < ofs + 4 ) return;
					maskingKey = buf.slice( ofs, ofs + 4 );
					ofs += 4;
				}

				if( len > MAX_PAYLOAD ){
					const frame = closeFrame( 1009, 'Payload too large' );
					os.write( fds[ 1 ], frame.buffer, 0, frame.length );
					this.#closing= true;
					this.#closeTimeout = setTimeout( () => {
						closeTcp( fds );
						this.#closing= false;
						this.#closeTimeout = undefined;
					}, 5000 );
					return;
				}

				if ( buf.length < ofs + len ) return;

				if( opcode >= 0x8 ){
					if( opcode > 0xA || !fin || len > 125 ){
						// bad frame close
						return;
					}

					let payload = masked
						? buf.slice( ofs, ofs + len ).map( ( byte, i ) => byte ^ maskingKey[i % 4] )
						: buf.slice( ofs, ofs + len );

					switch( opcode ){
						case 0x8:	//close
							if( this.#closing ){ // response to echoed close
								console.log( 'close server response' );
								if( this.#role == 'server' ){
									closeTcp( this.#fds );
									this.#closing = false;
								}
								// client ignores
							} else {
								let code = new DataView( payload.buffer ).getUint16( 0 );
								let reason = dec.decode( payload.slice( 2 ) );
								console.log( `${ this.#role } received close. code: ${ code }, reason: ${ reason }` );
								this.#listenerFuncs.close( { code, reason } );
								const frame = wsFrame( opcode, buf.slice( ofs, ofs + len ) );
								os.write( this.#fds[1], frame.buffer, 0, frame.byteLength );

								if( this.#role == 'client' ){
									this.#closing = true;
									this.#closeTimeout = os.setTimeout( () => {
										closeTcp( this.#fds );
										this.#listenerFuncs.close( { code: 1006, reason: 'Abnormal closure' } );
										this.#closing = false;
										this.#closeTimeout = undefined;
									}, 5000 );
								}else{
									console.log( `${ this.#role } closeTcp` );
									closeTcp( this.#fds );
								}
							}
							break;

						case 0x9: //ping
							{
								const frame = wsFrame( 0xA, buf.slice( ofs, ofs + len ), this.#role == 'client' ? 'mask' : undefined );
								os.write( this.#fds[1], frame.buffer, 0, frame.byteLength );
							}
							break;

						case 0xA: //pong
							this.#listenerFuncs.pong();
							break;
					}
					return;
				}

				if( ( continueOpcode == 0 &&  opcode == 0 )
						|| ( continueOpcode != 0 &&  opcode != 0 ) ){
					continueOpcode = 0, msg = '';
					const frame = closeFrame( 1002, 'protocol error' );
					os.write( fds[ 1 ], frame.buffer, 0, frame.length );
					this.#closing= true;
					this.#closeTimeout = setTimeout( () => {
						closeTcp( fds );
						this.#closing= false;
						this.#closeTimeout = undefined;
					}, 5000 );
					return;
				}

				switch( opcode ){
					case 0:
					case 1:
					case 2:
						let payload = masked
							? buf.slice( ofs, ofs + len ).map( ( byte, i ) => byte ^ maskingKey[i % 4] )
							: buf.slice( ofs, ofs + len );

						if( opcode == 1 || continueOpcode == 1 ){
							chunks.push( String.fromCharCode.apply( null, payload ) );
						} else {
							totalLength += len;
							chunks.push( payload );
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

					default:
						// bad opcode
				}
				buf =  buf.slice( ofs + len ); // working buf is now whatever wasn't part of sent frame
			}
		} );
	};

	on( event, func ){ if( this.#listenerNames.includes( event ) ) this.#listenerFuncs[ event] = func; };
	ping() {
		const frame = wsFrame( 0x9, new Uint8Array( 0 ), 'mask' );
		os.write( this.#fds[1], frame.buffer, 0, frame.length );
	}

	send( message ) {
		const payload = enc.encode( message );
		const frame = wsFrame( typeof message == 'string' ? 0x1 : 0x2, payload );
		os.write( this.#fds[1], frame.buffer, 0, frame.length );
	}

	close(){
		this.#closing = true;
		const frame = closeFrame( 1000, 'application close' );
		os.write( this.#fds[ 1 ], frame.buffer, 0, frame.length );
		this.#closeTimeout = os.setTimeout( () => {
			closeTcp( this.#fds );
			//this.#listenerFuncs.close( { code: 1000, reason: 'Normal closure' } );
			this.#closing = false;
			this.#closeTimeout = undefined;
		}, 5000 );
	};
}