// dc_module.c
// QuickJS native module wrapping libdatachannel's C API.
// Modeled after juice_module.c — same pipe-based async pattern,
// same MSG_* protocol, same JS-side usage shape.
//
// Build (example):
//   gcc -shared -fPIC -o dc.so dc_module.c \
//       -I/usr/local/include -L/usr/local/lib \
//       -ldatachannel -lquickjs
//
// JS usage:
//   import { PeerConnection } from './dc.so';

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>   // htonl
#include "quickjs.h"
#include "rtc/rtc.h"     // libdatachannel C API

#define countof(x) (sizeof(x) / sizeof((x)[0]))

#ifdef JS_SHARED_LIBRARY
#define JS_INIT_MODULE js_init_module
#else
#define JS_INIT_MODULE js_init_module_dc
#endif

// ---------------------------------------------------------------------------
// Wire protocol — identical to juice_module.c so JS side needs no changes
// ---------------------------------------------------------------------------

typedef enum msg_type {
    MSG_SDP          = 0x01,  // payload: SDP string  (JS <--> C)
    MSG_CLOSE        = 0x02,  // payload: none         (JS --> C)
    MSG_DATA         = 0x03,  // payload: raw bytes    (JS <--> C)
    MSG_CONNECTED    = 0x04,  // payload: none         (JS <-- C)
    MSG_DISCONNECTED = 0x05,  // payload: none         (JS <-- C)
    // DC-specific extras carried transparently
    MSG_DC_OPEN      = 0x06,  // payload: channel label string
    MSG_DC_CLOSE     = 0x07,  // payload: channel label string
		MSG_BUFFERED_LOW = 0x08		// payload: none
} msg_type_t;

static bool write_all(int fd, const void *buf, size_t len) {
    const uint8_t *p = buf;
    size_t written = 0;
    while (written < len) {
        ssize_t n = write(fd, p + written, len - written);
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            return false;
        }
        written += (size_t)n;
    }
    return true;
}

static bool write_msg(int fd, msg_type_t type, const void *payload, uint32_t len) {
    uint8_t header[5];
    uint32_t net_len = htonl(len);
    header[0] = (uint8_t)type;
    memcpy(header + 1, &net_len, 4);
    if (!write_all(fd, header, 5)) return false;
    if (len > 0 && !write_all(fd, payload, len)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Per-PeerConnection context
// ---------------------------------------------------------------------------

typedef struct {
    int  pc;           // libdatachannel peer-connection handle
    int  dc;           // first/default DataChannel handle (-1 until open)
    int  write_fd;     // libdatachannel callbacks --> JS
    int  read_fd;      // JS reads events from here (exposed as .fd)
    bool initiator;
		bool sdp_sent;
} dc_ctx_t;

// ---------------------------------------------------------------------------
// libdatachannel callbacks  (called from internal threads — write to pipe only)
// ---------------------------------------------------------------------------

/*static void cb_local_description(int pc, const char *sdp, const char *type, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    (void)pc; (void)type;
    // Send the full SDP blob; JS side forwards it to signaling server as-is.
    write_msg(ctx->write_fd, MSG_SDP, sdp, (uint32_t)strlen(sdp));
}*/

static void cb_gathering_state(int pc, rtcGatheringState state, void *user_ptr) {
    dc_ctx_t *ctx = (dc_ctx_t *)user_ptr;
    if (state == RTC_GATHERING_COMPLETE && !ctx->sdp_sent) {
				ctx->sdp_sent = true;
        char sdp[4096];
        rtcGetLocalDescription(pc, sdp, sizeof(sdp));
        write_msg(ctx->write_fd, MSG_SDP, sdp, (uint32_t)strlen(sdp));
    }
}

static void cb_state_change(int pc, rtcState state, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    (void)pc;
    if (state == RTC_CONNECTED)    write_msg(ctx->write_fd, MSG_CONNECTED,    NULL, 0);
    if (state == RTC_DISCONNECTED) write_msg(ctx->write_fd, MSG_DISCONNECTED, NULL, 0);
    if (state == RTC_FAILED)       write_msg(ctx->write_fd, MSG_DISCONNECTED, NULL, 0);
}

// Shared message/open/close callbacks reused for every DataChannel handle.
// We stash the channel's label in MSG_DC_OPEN / MSG_DC_CLOSE payloads so the
// JS side can multiplex named channels if it wants to.

static void cb_dc_open(int dc, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    char label[256] = {0};
    rtcGetDataChannelLabel(dc, label, sizeof(label));
    write_msg(ctx->write_fd, MSG_DC_OPEN, label, (uint32_t)strlen(label));
}

static void cb_dc_close(int dc, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    char label[256] = {0};
    rtcGetDataChannelLabel(dc, label, sizeof(label));
    write_msg(ctx->write_fd, MSG_DC_CLOSE, label, (uint32_t)strlen(label));
}

static void cb_dc_message(int dc, const char *msg, int size, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    (void)dc;
		//printf("cb_dc_message raw size=%d\n", size);
    // size < 0 means binary with abs(size) bytes; > 0 means text
    uint32_t len = (uint32_t)(size < 0 ? -size : size);
		/*printf("cb_dc_message (%zu) [ ", len);
    for (size_t i = 0; i < len; i++) {
        printf("%u", msg[i]);
        if (i < len - 1) {
            printf(", ");
        }
    }
    printf(" ]\n");*/
    write_msg(ctx->write_fd, MSG_DATA, msg, len);
}


static void cb_dc_buffered_low(int dc, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    (void)dc;
    write_msg(ctx->write_fd, MSG_BUFFERED_LOW, NULL, 0);
}

// Called when the remote peer creates a DataChannel (answerer side)
static void cb_dc_incoming(int pc, int dc, void *user_ptr) {
    dc_ctx_t *ctx = user_ptr;
    (void)pc;
    ctx->dc = dc;   // track the first incoming channel
    rtcSetOpenCallback(dc,    cb_dc_open);
    rtcSetClosedCallback(dc,  cb_dc_close);
    rtcSetMessageCallback(dc, cb_dc_message);
		rtcSetBufferedAmountLowCallback(dc, cb_dc_buffered_low);
}

// ---------------------------------------------------------------------------
// JS class bookkeeping
// ---------------------------------------------------------------------------

static JSClassID dc_class_id;

// ---------------------------------------------------------------------------
// Constructor:  new PeerConnection({ stun_host, stun_port, initiator, label? })
// ---------------------------------------------------------------------------

static JSValue js_dc_ctor(JSContext *ctx, JSValueConst new_target,
                           int argc, JSValueConst *argv) {
    rtcInitLogger(RTC_LOG_FATAL, NULL);

    if (argc < 1) return JS_ThrowTypeError(ctx, "options object required");

    JSValue stun_host_val  = JS_GetPropertyStr(ctx, argv[0], "stun_host");
    JSValue stun_port_val  = JS_GetPropertyStr(ctx, argv[0], "stun_port");
    JSValue initiator_val  = JS_GetPropertyStr(ctx, argv[0], "initiator");
    JSValue label_val      = JS_GetPropertyStr(ctx, argv[0], "label");

    const char *stun_host = JS_ToCString(ctx, stun_host_val);
    uint32_t    stun_port = 19302;
    JS_ToUint32(ctx, &stun_port, stun_port_val);
    bool initiator = !JS_IsUndefined(initiator_val) && JS_ToBool(ctx, initiator_val);
    //const char *label = JS_IsUndefined(label_val) ? "data" : JS_ToCString(ctx, label_val);
		const char *label_str = JS_IsUndefined(label_val) ? NULL : JS_ToCString(ctx, label_val);
		const char *label = label_str ? label_str : "data";

    JS_FreeValue(ctx, stun_host_val);
    JS_FreeValue(ctx, stun_port_val);
    JS_FreeValue(ctx, initiator_val);
    JS_FreeValue(ctx, label_val);

    // Pipe: libdatachannel threads write, QuickJS event loop reads
    int fds[2];
    if (pipe(fds) != 0) return JS_ThrowInternalError(ctx, "pipe() failed");

    dc_ctx_t *dctx = js_mallocz(ctx, sizeof(dc_ctx_t));
    dctx->read_fd  = fds[0];
    dctx->write_fd = fds[1];
    dctx->dc       = -1;
    dctx->initiator = initiator;

    // Build STUN URL  e.g. "stun:stun.l.google.com:19302"
    char stun_url[256];
    snprintf(stun_url, sizeof(stun_url), "stun:%s:%u", stun_host, stun_port);
    JS_FreeCString(ctx, stun_host);

    const char *ice_servers[] = { stun_url };
    rtcConfiguration config;
    memset(&config, 0, sizeof(config));
    config.iceServers     = ice_servers;
    config.iceServersCount = 1;

    dctx->pc = rtcCreatePeerConnection(&config);

    rtcSetUserPointer(dctx->pc, dctx);
    //rtcSetLocalDescriptionCallback(dctx->pc, cb_local_description);
		rtcSetGatheringStateChangeCallback(dctx->pc, cb_gathering_state);
    rtcSetStateChangeCallback(dctx->pc, cb_state_change);
    rtcSetDataChannelCallback(dctx->pc, cb_dc_incoming);  // answerer path
		rtcSetBufferedAmountLowThreshold(dctx->dc, 16384);  // 16KB = 4 chunks

    if (initiator) {
        // Offerer: create a DataChannel — this triggers SDP generation
        dctx->dc = rtcCreateDataChannel(dctx->pc, label);
        rtcSetOpenCallback(dctx->dc,    cb_dc_open);
        rtcSetClosedCallback(dctx->dc,  cb_dc_close);
        rtcSetMessageCallback(dctx->dc, cb_dc_message);
				rtcSetBufferedAmountLowCallback(dctx->dc, cb_dc_buffered_low);
        // Kick off ICE gathering
        rtcSetLocalDescription(dctx->pc, "offer");
    }

    //JS_FreeCString(ctx, label);
		if (label_str) JS_FreeCString(ctx, label_str);  // only free if we allocated it

    // Build the JS object
    JSValue obj = JS_NewObjectClass(ctx, dc_class_id);
    JS_SetOpaque(obj, dctx);

    JS_DefinePropertyValueStr(ctx, obj, "fd",
        JS_NewInt32(ctx, dctx->read_fd), JS_PROP_ENUMERABLE);
    JS_DefinePropertyValueStr(ctx, obj, "initiator",
        JS_NewBool(ctx, initiator), JS_PROP_ENUMERABLE);

    return obj;
}

// ---------------------------------------------------------------------------
// Instance methods
// ---------------------------------------------------------------------------

// agent.connect(remoteSdp)  — answerer path (mirrors juice connect())
static JSValue js_dc_connect(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    dc_ctx_t *dctx = JS_GetOpaque(this_val, dc_class_id);
    if (!dctx) return JS_EXCEPTION;

    const char *sdp = JS_ToCString(ctx, argv[0]);
    rtcSetRemoteDescription(dctx->pc, sdp, "offer");
    // Answerer: generate answer + gather candidates
    rtcSetLocalDescription(dctx->pc, "answer");
    JS_FreeCString(ctx, sdp);
    return JS_UNDEFINED;
}

// agent.setRemoteDescription(sdp)  — offerer path after receiving answer
static JSValue js_dc_set_remote_description(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv) {
    dc_ctx_t *dctx = JS_GetOpaque(this_val, dc_class_id);
    if (!dctx) return JS_EXCEPTION;

    const char *sdp = JS_ToCString(ctx, argv[0]);
    rtcSetRemoteDescription(dctx->pc, sdp, "answer");
    JS_FreeCString(ctx, sdp);
    return JS_UNDEFINED;
}

// agent.send(arrayBuffer)
static JSValue js_dc_send(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    dc_ctx_t *dctx = JS_GetOpaque(this_val, dc_class_id);
    if (!dctx || dctx->dc < 0) return JS_EXCEPTION;

    size_t len;
    uint8_t *data = JS_GetArrayBuffer(ctx, &len, argv[0]);
    if (!data) return JS_EXCEPTION;

    /*printf("js_dc_send Uint8Array(%zu) [ ", len);
    for (size_t i = 0; i < len; i++) {
        printf("%u", data[i]);
        if (i < len - 1) {
            printf(", ");
        }
    }
    printf(" ]\n");*/
    // Positive size = binary in libdatachannel's C API
    rtcSendMessage(dctx->dc, (const char *)data, len);
    return JS_UNDEFINED;
}

// agent.sendText(string)  — convenience for text messages
static JSValue js_dc_send_text(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    dc_ctx_t *dctx = JS_GetOpaque(this_val, dc_class_id);
    if (!dctx || dctx->dc < 0) return JS_EXCEPTION;

    const char *text = JS_ToCString(ctx, argv[0]);
		// Negative size = text in libdatachannel's C API
    rtcSendMessage(dctx->dc, text, -(int)strlen(text));   // positive = text
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

// agent.close()
static JSValue js_dc_close(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    dc_ctx_t *dctx = JS_GetOpaque(this_val, dc_class_id);
    if (!dctx) return JS_EXCEPTION;

    if (dctx->dc >= 0) rtcDeleteDataChannel(dctx->dc);
    rtcDeletePeerConnection(dctx->pc);
    close(dctx->write_fd);
    close(dctx->read_fd);
    js_free(ctx, dctx);
    JS_SetOpaque(this_val, NULL);
    return JS_UNDEFINED;
}

// agent.getBufferedAmount
static JSValue js_rtc_get_buffered_amount(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
		dc_ctx_t *dctx = JS_GetOpaque(this_val, dc_class_id);
    if (!dctx || dctx->dc < 0) return JS_EXCEPTION;
    return JS_NewInt32(ctx, rtcGetBufferedAmount(dctx->dc));
}

// ---------------------------------------------------------------------------
// Class / module wiring
// ---------------------------------------------------------------------------

static JSClassDef dc_class = { "PeerConnection" };

static const JSCFunctionListEntry dc_proto_funcs[] = {
    JS_CFUNC_DEF("connect",               1, js_dc_connect),
    JS_CFUNC_DEF("setRemoteDescription",  1, js_dc_set_remote_description),
    JS_CFUNC_DEF("sendBuf",                  1, js_dc_send),
    JS_CFUNC_DEF("sendText",              1, js_dc_send_text),
    JS_CFUNC_DEF("close",                 0, js_dc_close),
		JS_CFUNC_DEF("getBufferedAmount",			0, js_rtc_get_buffered_amount)
};

static const JSCFunctionListEntry dc_static_funcs[] = {
    JS_PROP_INT32_DEF("MSG_SDP",          MSG_SDP,          JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_CLOSE",        MSG_CLOSE,        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_DATA",         MSG_DATA,         JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_CONNECTED",    MSG_CONNECTED,    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_DISCONNECTED", MSG_DISCONNECTED, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_DC_OPEN",      MSG_DC_OPEN,      JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_DC_CLOSE",     MSG_DC_CLOSE,     JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
		JS_PROP_INT32_DEF("MSG_BUFFERED_LOW", MSG_BUFFERED_LOW,     JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
};

static int js_dc_module_init(JSContext *ctx, JSModuleDef *m) {
    JS_NewClassID(&dc_class_id);
    JS_NewClass(JS_GetRuntime(ctx), dc_class_id, &dc_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, dc_proto_funcs, countof(dc_proto_funcs));

    JSValue ctor = JS_NewCFunction2(ctx, js_dc_ctor, "PeerConnection", 1,
                                    JS_CFUNC_constructor, 0);
    JS_SetPropertyFunctionList(ctx, ctor, dc_static_funcs, countof(dc_static_funcs));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, dc_class_id, proto);

    JS_SetModuleExport(ctx, m, "PeerConnection", ctor);
    return 0;
}

JSModuleDef *JS_INIT_MODULE(JSContext *ctx, const char *module_name) {
    JSModuleDef *m = JS_NewCModule(ctx, module_name, js_dc_module_init);
    if (!m) return NULL;
    JS_AddModuleExport(ctx, m, "PeerConnection");
    return m;
}
