
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * Environment variables [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env`. Like [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), this module cannot be imported into client-side code. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * _Unlike_ [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), the values exported from this module are statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * ```ts
 * import { API_KEY } from '$env/static/private';
 * ```
 * 
 * Note that all environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * 
 * ```
 * MY_FEATURE_FLAG=""
 * ```
 * 
 * You can override `.env` values from the command line like so:
 * 
 * ```sh
 * MY_FEATURE_FLAG="enabled" npm run dev
 * ```
 */
declare module '$env/static/private' {
	export const USER: string;
	export const npm_config_user_agent: string;
	export const BETTER_AUTH_SECRET: string;
	export const HOSTNAME: string;
	export const GIT_ASKPASS: string;
	export const npm_node_execpath: string;
	export const SHLVL: string;
	export const npm_config_noproxy: string;
	export const HOME: string;
	export const CHROME_DESKTOP: string;
	export const OLDPWD: string;
	export const DISABLE_AUTO_UPDATE: string;
	export const TERM_PROGRAM_VERSION: string;
	export const NVM_BIN: string;
	export const npm_package_json: string;
	export const NVM_INC: string;
	export const WORKSPACE_ROOT_PATH: string;
	export const PAGER: string;
	export const PRIVATE_DATABASE_URL: string;
	export const VSCODE_GIT_ASKPASS_MAIN: string;
	export const PRIVATE_TURSO_AUTH_TOKEN: string;
	export const VSCODE_GIT_ASKPASS_NODE: string;
	export const PRIVATE_TURSO_DATABASE_URL: string;
	export const npm_config_userconfig: string;
	export const npm_config_local_prefix: string;
	export const npm_config_yes: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const COLORTERM: string;
	export const COLOR: string;
	export const PRIVATE_R2_BUCKET: string;
	export const NVM_DIR: string;
	export const PRIVATE_DISCORD_CLIENT_ID: string;
	export const CF_TOKEN_ID: string;
	export const PRIVATE_DISCORD_CLIENT_SECRET: string;
	export const PRIVATE_R2_PUBLIC_ENDPOINT: string;
	export const _: string;
	export const npm_config_prefix: string;
	export const npm_config_npm_version: string;
	export const TERM: string;
	export const npm_config_cache: string;
	export const PRIVATE_R2_ACCESS_KEY_ID: string;
	export const SUCCESS_URL: string;
	export const RUSTUP_HOME: string;
	export const COMPOSER_NO_INTERACTION: string;
	export const PRIVATE_R2_ENDPOINT: string;
	export const PRIVATE_R2_SECRET_ACCESS_KEY: string;
	export const npm_config_node_gyp: string;
	export const PATH: string;
	export const NODE: string;
	export const npm_package_name: string;
	export const GDK_BACKEND: string;
	export const CURSOR_AGENT: string;
	export const DISPLAY: string;
	export const LANG: string;
	export const PRIVATE_TURSO_DATABASE_URL_PROD: string;
	export const XAUTHORITY: string;
	export const VSCODE_GIT_IPC_HANDLE: string;
	export const TERM_PROGRAM: string;
	export const CURSOR_TRACE_ID: string;
	export const npm_config_loglevel: string;
	export const npm_lifecycle_script: string;
	export const BETTER_AUTH_URL: string;
	export const ORIGINAL_XDG_CURRENT_DESKTOP: string;
	export const SHELL: string;
	export const npm_lifecycle_event: string;
	export const NO_AT_BRIDGE: string;
	export const GIT_DISCOVERY_ACROSS_FILESYSTEM: string;
	export const PRIVATE_POLAR_ACCESS_TOKEN: string;
	export const RUST_VERSION: string;
	export const VSCODE_GIT_ASKPASS_EXTRA_ARGS: string;
	export const npm_config_globalconfig: string;
	export const npm_config_init_module: string;
	export const PWD: string;
	export const LC_ALL: string;
	export const npm_execpath: string;
	export const CARGO_HOME: string;
	export const NVM_CD_FLAGS: string;
	export const npm_config_global_prefix: string;
	export const npm_command: string;
	export const PIP_NO_INPUT: string;
	export const CF_ACCOUNT_ID: string;
	export const CF_DATABASE_ID: string;
	export const INIT_CWD: string;
	export const EDITOR: string;
	export const NODE_ENV: string;
}

/**
 * Similar to [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private), except that it only includes environment variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Values are replaced statically at build time.
 * 
 * ```ts
 * import { PUBLIC_BASE_URL } from '$env/static/public';
 * ```
 */
declare module '$env/static/public' {
	export const PUBLIC_APP_NAME: string;
	export const PUBLIC_ADSENSE_ENABLE_DEV: string;
	export const PUBLIC_ADMIN_WF_ID: string;
	export const PUBLIC_BASE_URL: string;
	export const PUBLIC_ADSENSE_CLIENT_ID: string;
	export const PUBLIC_POLAR_SUPPORTER_PRODUCT_ID: string;
}

/**
 * This module provides access to runtime environment variables, as defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * This module cannot be imported into client-side code.
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * console.log(env.DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` always includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 */
declare module '$env/dynamic/private' {
	export const env: {
		USER: string;
		npm_config_user_agent: string;
		BETTER_AUTH_SECRET: string;
		HOSTNAME: string;
		GIT_ASKPASS: string;
		npm_node_execpath: string;
		SHLVL: string;
		npm_config_noproxy: string;
		HOME: string;
		CHROME_DESKTOP: string;
		OLDPWD: string;
		DISABLE_AUTO_UPDATE: string;
		TERM_PROGRAM_VERSION: string;
		NVM_BIN: string;
		npm_package_json: string;
		NVM_INC: string;
		WORKSPACE_ROOT_PATH: string;
		PAGER: string;
		PRIVATE_DATABASE_URL: string;
		VSCODE_GIT_ASKPASS_MAIN: string;
		PRIVATE_TURSO_AUTH_TOKEN: string;
		VSCODE_GIT_ASKPASS_NODE: string;
		PRIVATE_TURSO_DATABASE_URL: string;
		npm_config_userconfig: string;
		npm_config_local_prefix: string;
		npm_config_yes: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		COLORTERM: string;
		COLOR: string;
		PRIVATE_R2_BUCKET: string;
		NVM_DIR: string;
		PRIVATE_DISCORD_CLIENT_ID: string;
		CF_TOKEN_ID: string;
		PRIVATE_DISCORD_CLIENT_SECRET: string;
		PRIVATE_R2_PUBLIC_ENDPOINT: string;
		_: string;
		npm_config_prefix: string;
		npm_config_npm_version: string;
		TERM: string;
		npm_config_cache: string;
		PRIVATE_R2_ACCESS_KEY_ID: string;
		SUCCESS_URL: string;
		RUSTUP_HOME: string;
		COMPOSER_NO_INTERACTION: string;
		PRIVATE_R2_ENDPOINT: string;
		PRIVATE_R2_SECRET_ACCESS_KEY: string;
		npm_config_node_gyp: string;
		PATH: string;
		NODE: string;
		npm_package_name: string;
		GDK_BACKEND: string;
		CURSOR_AGENT: string;
		DISPLAY: string;
		LANG: string;
		PRIVATE_TURSO_DATABASE_URL_PROD: string;
		XAUTHORITY: string;
		VSCODE_GIT_IPC_HANDLE: string;
		TERM_PROGRAM: string;
		CURSOR_TRACE_ID: string;
		npm_config_loglevel: string;
		npm_lifecycle_script: string;
		BETTER_AUTH_URL: string;
		ORIGINAL_XDG_CURRENT_DESKTOP: string;
		SHELL: string;
		npm_lifecycle_event: string;
		NO_AT_BRIDGE: string;
		GIT_DISCOVERY_ACROSS_FILESYSTEM: string;
		PRIVATE_POLAR_ACCESS_TOKEN: string;
		RUST_VERSION: string;
		VSCODE_GIT_ASKPASS_EXTRA_ARGS: string;
		npm_config_globalconfig: string;
		npm_config_init_module: string;
		PWD: string;
		LC_ALL: string;
		npm_execpath: string;
		CARGO_HOME: string;
		NVM_CD_FLAGS: string;
		npm_config_global_prefix: string;
		npm_command: string;
		PIP_NO_INPUT: string;
		CF_ACCOUNT_ID: string;
		CF_DATABASE_ID: string;
		INIT_CWD: string;
		EDITOR: string;
		NODE_ENV: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * Similar to [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), but only includes variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Note that public dynamic environment variables must all be sent from the server to the client, causing larger network requests — when possible, use `$env/static/public` instead.
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.PUBLIC_DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		PUBLIC_APP_NAME: string;
		PUBLIC_ADSENSE_ENABLE_DEV: string;
		PUBLIC_ADMIN_WF_ID: string;
		PUBLIC_BASE_URL: string;
		PUBLIC_ADSENSE_CLIENT_ID: string;
		PUBLIC_POLAR_SUPPORTER_PRODUCT_ID: string;
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
