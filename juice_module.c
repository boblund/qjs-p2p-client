// juice_module.c

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include "quickjs.h"
#include "juice.h"

#define countof(x) (sizeof(x) / sizeof((x)[0]))

#ifdef JS_SHARED_LIBRARY
#define JS_INIT_MODULE js_init_module
#else
#define JS_INIT_MODULE js_init_module_juice
#endif

static void sigint_handler(int sig) {
    (void)sig;
		// do any cleanup
		raise(SIGUSR1); // let JS side do any cleanup
}

typedef enum msg_type{
    MSG_SDP   				= 0x01, // payload: base64 sdp string JS <--> Agent
    MSG_CLOSE   			= 0x02, // payload: none  JS --> Agent
    MSG_DATA    			= 0x03, // payload: raw bytes (text or binary)  JS <--> Agent, Agent <--> Agent
    MSG_CONNECTED			= 0x04, // payload: none  JS <-- Agent
		MSG_DISCONNECTED	=	0X05,
		MSG_ACK						= 0x11, // b2: sequence # Agent <--> Agent
		MSG_NACK					= 0x12, // b2: sequence # Agent <--> Agent
} msg_type_t;

typedef struct {
    juice_agent_t *agent;
    int write_fd;    // libjuice callbacks → JS
    int read_fd;     // JS reads events from this
} juice_ctx_t;

static bool write_msg(int fd, msg_type_t type, const void *payload, uint32_t len) {
    uint8_t header[5];
    uint32_t net_len = htonl(len);
    header[0] = (uint8_t)type;
    memcpy(header + 1, &net_len, 4);
		int n = write(fd, header, 5);
		if ( n != 5) return false;
    if(len > 0){
			n = write(fd, payload, len);
			if(n != len) return false;
		}
    return true;
}

// callbacks — write to pipe from libjuice's internal thread to JS os.setReadHandler for async actions
static void on_state_changed(juice_agent_t *agent, juice_state_t state, void *user_ptr) {
    juice_ctx_t *ctx = user_ptr;
		if (state == JUICE_STATE_COMPLETED) {
			write_msg(ctx->write_fd, MSG_CONNECTED, NULL, 0);
		}
		if (state == JUICE_STATE_FAILED) {
			write_msg(ctx->write_fd, MSG_DISCONNECTED, NULL, 0);
		}
}

static void on_gathering_done(juice_agent_t *agent, void *user_ptr) {
    juice_ctx_t *ctx = user_ptr;
		char sdp[JUICE_MAX_SDP_STRING_LEN];
		juice_get_local_description(ctx->agent, sdp, sizeof(sdp));
		write_msg(ctx->write_fd, MSG_SDP, sdp, strlen(sdp));
}

static void on_recv(juice_agent_t *agent, const char *data, size_t size, void *user_ptr) {
    juice_ctx_t *ctx = user_ptr;
    write_msg(ctx->write_fd, MSG_DATA, data, size);
}

// class methods for JS to interact with libjuice

static JSClassID juice_class_id;

static JSValue js_juice_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    juice_ctx_t *jctx = JS_GetOpaque(this_val, juice_class_id);
    if (!jctx) return JS_EXCEPTION;

    // argv[0] = remote SDP string
    const char *sdp = JS_ToCString(ctx, argv[0]);
    juice_set_remote_description(jctx->agent, sdp);
    JS_FreeCString(ctx, sdp);
    juice_gather_candidates(jctx->agent);
    return JS_UNDEFINED;
}

static JSValue js_juice_set_remote_description(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    juice_ctx_t *jctx = JS_GetOpaque(this_val, juice_class_id);
    if (!jctx) return JS_EXCEPTION;

    // argv[0] = remote SDP string
    const char *sdp = JS_ToCString(ctx, argv[0]);
    juice_set_remote_description(jctx->agent, sdp);
    JS_FreeCString(ctx, sdp);
    return JS_UNDEFINED;
}

static JSValue js_juice_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    juice_ctx_t *jctx = JS_GetOpaque(this_val, juice_class_id);
    if (!jctx) return JS_EXCEPTION;

    size_t len;
    uint8_t *data = JS_GetArrayBuffer(ctx, &len, argv[0]);
    if (!data) return JS_EXCEPTION;

    juice_send(jctx->agent, (const char *)data, len);
    return JS_UNDEFINED;
}

static JSValue js_juice_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    juice_ctx_t *jctx = JS_GetOpaque(this_val, juice_class_id);
    if (!jctx) return JS_EXCEPTION;

    juice_destroy(jctx->agent);
    close(jctx->write_fd);
    close(jctx->read_fd);
    js_free(ctx, jctx);
    JS_SetOpaque(this_val, NULL);
    return JS_UNDEFINED;
}

// ---- constructor ----

static JSValue js_juice_ctor(JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv) {
		juice_set_log_level(JUICE_LOG_LEVEL_ERROR);
    // argv[0] = { stun_host, stun_port, initiator }
    JSValue stun_host_val = JS_GetPropertyStr(ctx, argv[0], "stun_host");
    JSValue stun_port_val = JS_GetPropertyStr(ctx, argv[0], "stun_port");
    JSValue initiator_val = JS_GetPropertyStr(ctx, argv[0], "initiator");
		if (JS_IsUndefined(initiator_val)) {
				// false if missing
				JS_FreeValue(ctx, initiator_val);
				initiator_val = JS_NewBool(ctx, 0);
		}
		JS_BOOL js_initiator = JS_ToBool(ctx, initiator_val);  // returns 0 or 1
		JS_FreeValue(ctx, initiator_val);

    const char *stun_host = JS_ToCString(ctx, stun_host_val);
    uint32_t stun_port;
    JS_ToUint32(ctx, &stun_port, stun_port_val);
    int initiator = JS_ToBool(ctx, initiator_val);

    JS_FreeValue(ctx, stun_host_val);
    JS_FreeValue(ctx, stun_port_val);
    JS_FreeValue(ctx, initiator_val);

    // JS pipe
    int fds[2];
    pipe(fds);

    juice_ctx_t *jctx = js_mallocz(ctx, sizeof(juice_ctx_t));
    jctx->read_fd  = fds[0];
    jctx->write_fd = fds[1];

    juice_config_t config;
    memset(&config, 0, sizeof(config));
    config.stun_server_host  = stun_host;
    config.stun_server_port  = (uint16_t)stun_port;
    config.cb_state_changed  = on_state_changed;
    //config.cb_candidate      = on_candidate; // no trickle ICE
    config.cb_gathering_done = on_gathering_done;
    config.cb_recv           = on_recv;
    config.user_ptr          = jctx;

    jctx->agent = juice_create(&config);
    JS_FreeCString(ctx, stun_host);

    if (initiator) {
        juice_gather_candidates(jctx->agent);
    }

    // create JS object with class
    JSValue obj = JS_NewObjectClass(ctx, juice_class_id);
    JS_SetOpaque(obj, jctx);

    JS_DefinePropertyValueStr(ctx, obj, "fd",
        JS_NewInt32(ctx, jctx->read_fd),
        JS_PROP_ENUMERABLE);

		JS_DefinePropertyValueStr(ctx, obj, "initiator",
				JS_NewBool(ctx, js_initiator),
				JS_PROP_ENUMERABLE);

    return obj;
}

// ---- class/module registration ----

static JSClassDef juice_class = {
    "Juice",
};

static const JSCFunctionListEntry juice_proto_funcs[] = {
    JS_CFUNC_DEF("connect",								1, js_juice_connect),
    JS_CFUNC_DEF("send",    							1, js_juice_send),
    JS_CFUNC_DEF("close",   							0, js_juice_close),
		JS_CFUNC_DEF("setRemoteDescription",	1, js_juice_set_remote_description)
};

static const JSCFunctionListEntry juice_static_funcs[] = {
    JS_PROP_INT32_DEF("MSG_SDP", MSG_SDP, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_CLOSE", MSG_CLOSE, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_DATA", MSG_DATA, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_CONNECTED", MSG_CONNECTED, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_PROP_INT32_DEF("MSG_DISCONNECTED", MSG_DISCONNECTED, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
};

static int js_juice_module_init(JSContext *ctx, JSModuleDef *m) {
    JS_NewClassID(&juice_class_id);
    JS_NewClass(JS_GetRuntime(ctx), juice_class_id, &juice_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, juice_proto_funcs, countof(juice_proto_funcs));

    JSValue ctor = JS_NewCFunction2(ctx, js_juice_ctor, "Juice", 1, JS_CFUNC_constructor, 0);
		JS_SetPropertyFunctionList(ctx, ctor, juice_static_funcs, countof(juice_static_funcs));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetClassProto(ctx, juice_class_id, proto);

    JS_SetModuleExport(ctx, m, "Juice", ctor);
    return 0;
}

JSModuleDef *JS_INIT_MODULE(JSContext *ctx, const char *module_name) {
		struct sigaction sa = {
        .sa_handler = sigint_handler,
        .sa_flags   = 0,
    };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    JSModuleDef *m = JS_NewCModule(ctx, module_name, js_juice_module_init);
		    if (!m)
        return NULL;
    JS_AddModuleExport(ctx, m, "Juice");
    return m;
}
