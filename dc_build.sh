git clone https://github.com/paullouisageneau/libdatachannel.git
cd libdatachannel
git submodule update --init --recursive --depth 1
cmake -B build \
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_C_COMPILER=/usr/bin/clang \
	-DCMAKE_CXX_COMPILER=/usr/bin/clang++ \
	-DUSE_GNUTLS=0 \
	-DUSE_MBEDTLS=0 \
	-DNO_MEDIA=1 \
	-DNO_WEBSOCKET=1 \
	-DBUILD_SHARED_LIBS=OFF
cmake --build build -j$(sysctl -n hw.logicalcpu)

#### To use
#gcc -L/path_to_libdatachannel/build/deps/libjuice -ljuice \
#		-L/path_to_libdatachannel/build/build -ldatachannel \
#		-L/path_to_libdatachannel/build/build/deps/usrsctp/usrsctplib -lusrsctp \
#								or mv libs to someplace, e.g. /usr/local/lib/libdatachannel, and
#		-L/usr/local/lib/libdatachannel -ldatachannel -lusrsctp -ljuice \
#		-lc++ \
#		all other .o, .a, -L, -l
