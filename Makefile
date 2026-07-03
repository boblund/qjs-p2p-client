QJSC = /usr/local/bin/qjsc
CC = gcc
CFLAGS = -O0 -g -Wall -fPIC \
			-I/usr/local/include/quickjs \
			-I/opt/homebrew/opt/openssl/include \
			-I/usr/local/include/libjuice \
			-I../libdatachannel/include

LDFLAGS = \
			-L/usr/local/lib/quickjs -lquickjs \
			-L/opt/homebrew/opt/openssl/lib \
			-L/usr/local/lib/libjuice \
			-L../libdatachannel/build -ldatachannel \
			-lssl -lcrypto -l juice -lm -lpthread -ldl

# juice
juice.o: juice_module.c
	$(CC) $(CFLAGS) -c juice_module.c -o juice.o

juice.so: juice_module.c
	$(CC) -fPIC -shared -DJS_SHARED_LIBRARY -o juice.so juice_module.c $(CFLAGS) $(LDFLAGS)

# socket
socket.o: socket.c
	$(CC) $(CFLAGS) -c socket.c -o socket.o

socket.so: socket.c
	$(CC) -fPIC -shared -DJS_SHARED_LIBRARY -o socket.so socket.c $(CFLAGS) $(LDFLAGS)

# client_p2p
client_p2p.c: client_p2p.mjs cognito.mjs parseUrl.mjs qjsWsClient.mjs EncodeDecode.mjs
	$(QJSC) -e -M socket.so,socket -M juice.so,juice -o client_p2p.c client_p2p.mjs

client_p2p.o: client_p2p.c
	$(CC) $(CFLAGS) -c client_p2p.c -o client_p2p.o

client_p2p: client_p2p.o juice.o socket.o
	$(CC) $(LDFLAGS) -o client_p2p client_p2p.o socket.o juice.o

# Datachannel version
dc.o: dc_module.c
	$(CC) $(CFLAGS) -c dc_module.c -o dc.o

p2p-client-dc.c: p2p-client-dc.mjs cognito.mjs parseUrl.mjs qjsWsClient.mjs EncodeDecode.mjs qjsPeer.mjs priorityChannel.mjs
	$(QJSC) -e -M socket.so,socket -M dc.so,dc -o p2p-client-dc.c p2p-client-dc.mjs

p2p-client-dc.o: p2p-client-dc.c
	$(CC) $(CFLAGS) -c p2p-client-dc.c -o p2p-client-dc.o

p2p-client-dc: p2p-client-dc.o dc.o socket.o
	$(CC) $(LDFLAGS) -lc++ ../libdatachannel/build/deps/usrsctp/usrsctplib/libusrsctp.a -o p2p-client-dc p2p-client-dc.o socket.o dc.o

.PHONY: clean

clean:
	rm -f juice.o dc.o client_p2p.[co] p2p-client-dc.[co]
