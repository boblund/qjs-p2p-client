export { TextEncoder, TextDecoder, toBase64, fromBase64 };

Uint8Array.prototype.toHex = function () {
	return Array.from( this, byte => `0x${ byte.toString( 16 ).padStart( 2, '0' ) }` );
};

function TextEncoder() {}
TextEncoder.prototype.encode = function( str ) {
	let buf = new Uint8Array( str.length * 4 );
	let j = 0;
	for ( let i = 0; i < str.length; i++ ) {
		let c = str.charCodeAt( i );
		if ( 0xD800 <= c && c <= 0xDBFF ) {
			const c2 = ( i + 1 < str.length ) ? str.charCodeAt( i + 1 ) : 0;
			if ( 0xDC00 <= c2 && c2 <= 0xDFFF ) {
				i++; // consume both surrogates
				c = 0x10000 + ( ( c & 0x3FF ) << 10 ) + ( c2 & 0x3FF );
			} else {
				c = 0xFFFD; // unpaired high surrogate
			}
		} else if ( 0xDC00 <= c && c <= 0xDFFF ) {
			c = 0xFFFD; // unpaired low surrogate
		}

		// Now encode the code point c
		if ( c < 0x80 ) {
			buf[j++] = c;
		} else if ( c < 0x800 ) {
			buf[j++] = 0xC0 | ( c >> 6 );
			buf[j++] = 0x80 | ( c & 0x3F );
		} else if ( c < 0x10000 ) {
			buf[j++] = 0xE0 | ( c >> 12 );
			buf[j++] = 0x80 | ( ( c >> 6 ) & 0x3F );
			buf[j++] = 0x80 | ( c & 0x3F );
		} else {
			buf[j++] = 0xF0 | ( c >> 18 );
			buf[j++] = 0x80 | ( ( c >> 12 ) & 0x3F );
			buf[j++] = 0x80 | ( ( c >> 6 ) & 0x3F );
			buf[j++] = 0x80 | ( c & 0x3F );
		}
	}
	return buf.slice( 0, j );
};

function TextDecoder() {}
TextDecoder.prototype.decode = function( uint8 ) {
	let str = '';
	for ( let i = 0; i < uint8.length; ) {
		let b = uint8[i++];
		if ( b < 0x80 ) {
			str += String.fromCharCode( b );
		} else if ( b < 0xE0 ) {
			str += String.fromCharCode( ( ( b & 0x1F ) << 6 ) | ( uint8[i++] & 0x3F ) );
		} else if ( b < 0xF0 ) {
			let c = ( ( b & 0xF ) << 12 )
            | ( ( uint8[i++] & 0x3F ) << 6 )
            | ( uint8[i++] & 0x3F );
			str += String.fromCharCode( c );
		} else {
			// 4‑byte UTF‑8 → surrogate pair in UTF‑16
			let c = ( ( b & 0x7 ) << 18 )
            | ( ( uint8[i++] & 0x3F ) << 12 )
            | ( ( uint8[i++] & 0x3F ) << 6 )
            | ( uint8[i++] & 0x3F );
			if ( c <= 0xFFFF ) {
				str += String.fromCharCode( c );
			} else {
				c -= 0x10000;
				str += String.fromCharCode(
					0xD800 | ( c >> 10 ),
					0xDC00 | ( c & 0x3FF )
				);
			}
		}
	}
	return str;
};

const b64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64( input ) {
	if( !( input instanceof Uint8Array || ( input instanceof String || typeof input === 'string' ) ) ){
		throw( 'error: input not Uint8Array or string' );
	}

	const uint8array = input instanceof Uint8Array
		? input
		: new TextEncoder.encode( input );

	let bitBuffer = 0; // sliding window of uint8array bits to be converted to b64
	let bitCnt = 0;
	let output = '';

	for( let i = 0; i < uint8array.length; i++ ){
		bitBuffer = ( bitBuffer << 8 ) | uint8array[ i ];
		bitCnt += 8;
		while( bitCnt >= 6 ){
			output += b64Chars[ ( bitBuffer >> bitCnt - 6 ) & 0x3f ]; // 6 MSB are b64 bits
			//bitBuffer = bitBuffer & ( ( 2 ** ( bitCnt - 6 ) ) - 1 ); // remove 6 MSB - not necessary?
			bitCnt -= 6;
		}
	}

	if( bitCnt > 0 ) // pad remaining to 6 bits
		output += b64Chars[ bitBuffer << ( 6 - bitCnt ) ] + ( bitCnt == 4 ? '=' : '==' );

	return output;
}

function fromBase64( b64String ) {
	//const chars = b64String.replaceAll( '=', '' );
	let bitBuffer = 0;
	let bitCount = 0;
	const bytes = [];

	for ( let i = 0; i < b64String.length; i++ ) {
		const val = b64Chars.indexOf( b64String[i] );
		if ( val === -1 ) continue; // Skip invalid chars

		bitBuffer = ( bitBuffer << 6 ) | val;
		bitCount += 6;

		while ( bitCount >= 8 ) {
			bytes.push( ( bitBuffer >>> ( bitCount - 8 ) ) & 0xFF );
			bitCount -= 8;
			bitBuffer = bitBuffer & 0xFFF; // never more than 12 LSB bits that haven't been copied to bytes
		}
	}
	return Uint8Array.from( bytes );
}

function test(){
	const print = console.log;
	// Test it works
	let enc = new TextEncoder();
	let dec = new TextDecoder();
	[ "A", "¢", "€", "🌌" ].forEach( s => print( s, 'encode', new TextEncoder().encode( s ).toHex(), 'decode', new TextDecoder().decode( enc.encode( s ) ) ) );
}

//test()
