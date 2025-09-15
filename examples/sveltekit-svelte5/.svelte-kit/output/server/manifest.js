export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set([]),
	mimeTypes: {},
	_: {
		client: {start:"_app/immutable/entry/start.D9OgSO9_.js",app:"_app/immutable/entry/app.-nd3YYJm.js",imports:["_app/immutable/entry/start.D9OgSO9_.js","_app/immutable/chunks/C-d1IvSO.js","_app/immutable/chunks/Cde5qClD.js","_app/immutable/chunks/DJAmPjUu.js","_app/immutable/entry/app.-nd3YYJm.js","_app/immutable/chunks/DJAmPjUu.js","_app/immutable/chunks/Cde5qClD.js","_app/immutable/chunks/Bzak7iHL.js","_app/immutable/chunks/BGWev-Kz.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/api/sync",
				pattern: /^\/api\/sync\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/sync/_server.ts.js'))
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
