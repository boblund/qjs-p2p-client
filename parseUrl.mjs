// url = [protocol://]v4|v6|host[:port][/path]
// returns { protocol, addr, port, path }

export function parseUrl( url ){
	let addr, path, port, protocol, ptr, urlEnd = url.length - 1 ;

	//find protocol
	if( ( ptr = url.indexOf( '://' ) ) != -1 ){
		protocol = url.substring( 0, ptr );
		ptr += 3;
	} else {
		ptr = 0;
	}

	// find addr
	if( url[ ptr ] == '[' ){
		let end = url.indexOf( ']', ptr );
		addr = url.substring( ptr + 1, end );
		ptr = end + 1;
	}

	let semi = url.indexOf( ':', ptr );
	let slash = url.indexOf( '/', ptr );

	if( addr == undefined ) {
		let end = semi != -1 ? semi - 1 : ( slash != -1 ? slash : urlEnd );
		addr = url.substring( ptr, end + ( semi == -1 && slash != -1 ? 0 : 1 ) );
		ptr = end;
	}

	// find port
	if( semi != -1 ){
		if( slash != -1 && slash < semi ) return undefined;
		let end = slash != -1 ? slash - 1 : urlEnd;
		port = Number( url.substring( ptr + 2, end + 1 ) );
		if( isNaN( port ) ) return undefined;
		ptr = end + 1;
	}

	// find path
	if( slash != -1 ) path = url.substring( ptr );

	return { protocol, addr, port, path };
}

function test(){
	let urls = [
		'wss://brume.occams.solutions/Prod',
		"https://cognito-idp.us-east-1.amazonaws.com:443",
		"bobsm1.local",
		"[fe80::1]",
		"https://bobsm1.local",
		"https://bobsm1.local:8080",
		"https://bobsm1.local:8080/path",
		"https://bobsm1.local/path",
		"https://bobsm1.local/:8080",
		"https://bobsm1.local::8080"
	];

	for( let i = 0; i < urls.length; i++ ){
		const ret = parseUrl( urls[ i ] );
		if( ret ){
			console.log( `url: ${ urls[ i ] } => ${ JSON.stringify( ret ) }` );
		}else{
			console.log( `bad url: ${ urls[ i ] }` );
		}
	}
}

//test();
