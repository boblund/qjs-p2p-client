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
