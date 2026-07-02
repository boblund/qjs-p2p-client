import * as os from 'os';
import { Client } from 'socket.so';
import { httpRequest } from '../chunked-test/httpRequest.mjs';

const REGION = 'us-east-1';
const CLIENT_ID = '6dspdoqn9q00f0v42c12qvkh5l';
const HOST = `cognito-idp.${ REGION }.amazonaws.com`;

let client;

export async function refreshIdToken( refreshToken ) {
	const ipService = 'InitiateAuth';
	const ipServicePayload = JSON.stringify( {
		AuthFlow: 'REFRESH_TOKEN_AUTH',
		ClientId: CLIENT_ID,
		AuthParameters: { REFRESH_TOKEN: refreshToken }
	} );

	const req = [
		`POST / HTTP/1.1`,
		`Host: ${ HOST }`,
		`Content-Type: application/x-amz-json-1.1`,
		`X-Amz-Target: AWSCognitoIdentityProviderService.${ ipService }`,
		`Content-Length: ${ ipServicePayload.length }`,
		`Connection: close`,
		``,
		ipServicePayload
	].join( '\r\n' );

	client = new Client();
	let fds = client.connect( { port: 443, host: HOST, tls: true } );
	let resp;

	try{
		resp = await httpRequest( fds, req );
		return JSON.parse( resp.body ).AuthenticationResult.IdToken;
	} catch( e ){
		throw e;
	}
}

// qjsc -e -M socket.so,socket -o cognito.c cognito.mjs
// gcc -I/usr/local/include/quickjs -c cognito.c -o cognito.o
// gcc -L/usr/local/lib/quickjs -L/opt/homebrew/opt/openssl/lib -lquickjs -lssl -lcrypto -lm -lpthread -ldl -o cognito cognito.o socket.o
/*try{
	let r = await refreshIdToken( "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIiwiYWxnIjoiUlNBLU9BRVAifQ.H1ULXpo_vtp2dgD6zWRrs-4-FNjxT9zwR0puPKabb4bxua0ipeLcHYOaI9L5XOWYvq44VIMgK-VfSNgwaJ0P6aD3H-X1AujzQtN81EFHIZ6xrwLcpX8AY0z_vt0dRdSV8Fg1tm69X7QoVX5JjRnaCmV_ZDJVA-h-kln7gYQIKVLmGJzYAtcP0xHJXcAdmUw7W2G-Yd1ZAIDyul1Oszh3J3WMbnsFiWEqSZM7StQJmxgEDC8TUIs1qsyrai0Qgyfj4vMjap_j_qD62N85coqs7jo7Ub9u0dMWomhUfXwEE8-jMBBWEn4OijZTujFV-HtG6zw_1U_NQPpJ6uhWCuXPEA.7Y1oICOF0ToDrkIM.0ICiH6LjykYeZkNRg2YFxYHIDkbp2WiphanEGtNHRgviOq4FBAoumBNe4HexXQXAfvjmL_c580bTPvCOXJ3D6abkHandNLp8nCZzKnMU2EwT_yo0EALQvCBFIVauywwtirn8jnrFylzIKHfDSDwd2SpSTZI8Cx7IDoYlgEgHAvdR4ZoHAbG3unQB1juBw3f7sYjeU6ZC1-I4eKyZnVqTYzhi4fYgicgKBgd-4m5VK-2hhtdEkwOaYULTlPmo4T4T5KDDQVFv9Mb3wqroyC8hVzHQkYj3brgtU-W5qjXL18SGTQKaNsbcsIqMDPPUxZNf3ZfGCCa4hW-QQlOwyOrOAZ3A9SHUaWx0gRpIEz_Fsc3Q2KmTFF98kovYCj3cilo438ZiYUKl5_qiSZw1eyvfAUiTFVZM076ajUYMMJBxqUH3z_43Yh22B6uSNtvB2Tlz8D_U1WzcOMwGlAQVVQLNpeK6BGPejhgQmLr8HzPWGnZby6Wu7ICelTgHRPMHbdCS_TX2CkpCJu_4ZMLpqXwt2ijzrO5RnPgKtudzsCfrKcx7IoStuRtRvQipp6zkAHMaX6PjewH1cJTz_ET2rLEr2zAd2zfYGLQ1d-N24YiTiF6Trt146l1TpVQ7U1YKCoamRz3pZLH9vd-I6CkBYRHRHH0sJJeHJacSMHP1mRbwqo2j59VK23KbQUzZalRWvMNoXkzI3496y0ycWflP8zj55CzlvvSjaINRdayDV12RokAwyT-_A9BEZT2Ng2UdlwHjtPZXTQlqAesKfi34gwqgXdpAd5fTgxtZDVULJCc6qwBY3jQEVTSaMgDAtQQA3x4Hpd2AkZEytXJc8p10K7D2LWxIIV9hoqfYvuoyh2qEeCATQeYwmZIb5EYXzqwzggm1vJ9m7oh_Gx4s3EU7hSirBvF9WgEJSsYT9NmqSIKWZAMe12wFvAtzgWr90Inxzz-gCiz7uJZS8ErB68IlbdLxKEJyEgZcWpIOaeGjylG9h6ADzA_GMHFmC0_VPFh_-0Fo9M85EIhPqQ4NU6wuINTths_g70c4SEF6b1HdycEVg1HWWsoLbM8fT8NnaMQsfSBk1IarmPRFs5cYWayo2OAYH6tlNZ7J317hz6gwUcWzgoZCSplzQO1k2v3E15C65481E5qoFEojHQBTrTj9UvpgojFHyqQDgtfpUuSgG1JU7ZpeNuGTmgjs82oyq7EiAbPxbTD-lNhloFfAaI4F_AxQrQA2oBHtF-3RT_mqHNIlVr-GrbGk-_4n7qvHfUTwKOzlWwoiDBjyeVLF6mPfK5y0i4heddS6J1tE6LqB4aVW91J3IDEerJcnJkf7yHw.-eiirF-hbN56wHAzLhQVrg" );
	console.log( 'IdToken:', r );
} catch( e ){
	console.log( 'refreshIdToken error:', e.status, '\nheaders\n', e.resp.headers, '\nbody\n', e.resp.body );
}*/
