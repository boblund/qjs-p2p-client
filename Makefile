QJSC = /usr/local/bin/qjsc
CC = gcc
CFLAGS = -O0 -g -Wall -fPIC \
			-I/usr/local/include/quickjs \
			-I/opt/homebrew/opt/openssl/include \
			-I/usr/local/include/libdatachannel

LDFLAGS = \
			-L/usr/local/lib/quickjs -lquickjs \
			-L/opt/homebrew/opt/openssl/lib -lssl -lcrypto \
			-L/usr/local/lib/libdatachannel -ldatachannel -lusrsctp -ljuice \
			-lm -lpthread -ldl
#
# To bundle all libs:
# libtool -static -o p2p-client-lib.a libdatachannel.a libjuice.a libusrsctp.a
#

# socket
socket.o: socket.c
	$(CC) $(CFLAGS) -c socket.c -o socket.o

socket.so: socket.c
	$(CC) -fPIC -shared -DJS_SHARED_LIBRARY -o socket.so socket.c $(CFLAGS) $(LDFLAGS)

# Datachannel version
dc.o: dc_module.c
	$(CC) $(CFLAGS) -c dc_module.c -o dc.o

p2p-client-dc.c: p2p-client-dc.mjs cognito.mjs parseUrl.mjs wsEndpoint.mjs EncodeDecode.mjs qjsPeer.mjs priorityChannel.mjs
	$(QJSC) -e -M socket.so,socket -M dc.so,dc -o p2p-client-dc.c p2p-client-dc.mjs

p2p-client-dc.o: p2p-client-dc.c
	$(CC) $(CFLAGS) -c p2p-client-dc.c -o p2p-client-dc.o

p2p-client-dc: p2p-client-dc.o dc.o socket.o
	$(CC) $(LDFLAGS) -lc++ -o p2p-client-dc p2p-client-dc.o socket.o dc.o

.PHONY: clean

clean:
	rm -f dc.o p2p-client-dc.[co]
