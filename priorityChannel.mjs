export { PriorityChannel };

class ArrayQueue extends Array{
	constructor(){ super(); }
	ready(){ return this.length > 0; }
	next(){ return this.shift(); }
}

class PriorityChannel {
	#highWaterMark;
	#lowWaterMark; // just for documentation of what is set in dc_module.c
	#queues = [];
	#draining = false;
	#sendFn;
	#getHwFn;
	#queuesOrder;

	constructor( { sendFn, getHwFn, queuesOrder, highWaterMark = 65536, lowWaterMark = 16384 } = {} ) {
		this.#highWaterMark = highWaterMark;
		this.#lowWaterMark = lowWaterMark;
		this.#queues = {};
		this.#draining = false;
		if( !sendFn || !getHwFn || !queuesOrder ) throw( 'new PriorityChannel: sendFn, getHwFn or queuesOrder not defined' );
		this.#sendFn = sendFn;
		this.#getHwFn = getHwFn;
		this.#queuesOrder = queuesOrder;
	}

	addQueue( name, queueImpl = new ArrayQueue ) {
		this.#queues[ name ] = queueImpl;
		return { name, queue: queueImpl };
	}

	send( queueName, item ) {
		if( this.#queues[ queueName ]?.push ) {
			this.#queues[ queueName ].push( item );
			this.pump();
		}
	}

	pump() {
		if( this.#draining ) return;
		this.#draining = true;
		while ( this.#getHwFn() < this.#highWaterMark ) {
			const queuesItem = this.#queuesOrder.find( l => this.#queues[ l ]?.ready() );
			if ( !queuesItem ) break; // nothing to send anywhere
			const queue = this.#queues[ queuesItem ];
			const item = queue.next();
			const { type, data } = item;
			this.#sendFn( { type, data } );
		}
		this.#draining = false;
	}
}

/* Test in quickjs
let peer;
const ch = new PriorityChannel( {
	sendFn( item ){ peer.send( item ); },
	getHwFn(){ return peer.getBufferedAmount(); }
} );

// Highest priority static array cmd queue
ch.addQueue( 'control' );

// Lazy queue
let buf = new Uint8Array( 4096 ), offset = 0, fd = -1;
ch.addQueue( 'chunks', new class {
	get length(){ return fd == -1 ? 0 : 1 };
	shift(){
		let n = os.read( fd, buf.buffer, 0, buf.length );
		if ( n <= 0 ){
			os.close( fd );
			fd = -1; offset = 0;
			return { type: n == 0 ? 'eof' : 'error' };
		} else {
			offset += n;
			return { type: 'chunk', data: buf.slice( 0, n ) };
		}
	}
} );

// Lowest priority new file transfer queue
ch.addQueue( 'file' );
*/

// test in nodejs

/*let sent = 0;
const ch = new PriorityChannel( {
	sendFn( item ){ console.log( item ); sent++; },
	getHwFn(){
		if( sent < 3 ){
			return 0;
		}else{
			return 65536;
		}
	},
	queuesOrder: [ 'control', 'chunks', 'file' ]
} );

// Highest priority static array cmd queue
ch.addQueue( 'control' );
ch.addQueue( 'file' );

setInterval( () => { sent = 0; ch.pump(); }, 5000 );
ch.send( 'control', { type: 'cmd', data: 'cmd' } );


// Lazy queue

class Chunks{
	#started = false;
	#fd = 1;
	#chunks;
	constructor( chunks ){ this.#chunks = chunks; };
	get ready(){ return this.#fd != -1; };
	get next(){
		this.#started = true;
		if ( this.#chunks.length == 0 ){
			this.#fd = -1;
			return { type: 'eof' };
		} else {
			return { type: 'chunk', data: this.#chunks.shift() };
		}
	}
};

// Lowest priority new file transfer queue
ch.send( 'file', {
	type: 'file',
	data: 'filename1',
	fn: function(){
		ch.addQueue( 'chunks', new Chunks( [ 1, 2, 3, 4, 5, 6 ] ) );
	}
} );

//ch.addQueue( 'file' );
ch.send( 'file', {
	type: 'file',
	data: 'filename2',
	fn: function(){
		ch.addQueue( 'chunks', new Chunks( [ 7, 8, 9 ] ) );
	}
} );*/
