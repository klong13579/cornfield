const path = require("path");
const fs = require("fs");

const CopyPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin");
const TsconfigPathsPlugin = require("tsconfig-paths-webpack-plugin");
const webpack = require("webpack");
const TerserJSPlugin = require("terser-webpack-plugin");
const OptimizeCSSAssetsPlugin = require("optimize-css-assets-webpack-plugin");

const tsConfigPath = path.join(__dirname, "../tsconfig.json");
const srcDir = path.join(__dirname, "../src/browser");
const distDir = path.join(__dirname, "../dist");
const publicDir = path.join(__dirname, "../public");

// omp 侧 ACP agent 可执行文件（dev 默认 bun + coding-agent cli，生产用 OMP_ACP_COMMAND=omp 覆盖）。
const ompCliTs = path.resolve(__dirname, "../../coding-agent/src/cli.ts");

const styleLoader =
	process.env.NODE_ENV === "production" ? MiniCssExtractPlugin.loader : require.resolve("style-loader");
const isDevelopment = process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "dev";
const port = 8080;

const idePkg = JSON.parse(
	fs.readFileSync(path.join(__dirname, "..", "./node_modules/@opensumi/ide-core-browser/package.json")).toString(),
);

// monaco worker 本地化：next 通道 CDN 路径 404，直接从 node_modules 复制到 dist 本地加载。
const monacoWorker = require.resolve("@opensumi/ide-monaco/worker/editor.worker.bundle.js");

module.exports = {
	entry: path.join(srcDir, "./index.ts"),
	output: {
		filename: "bundle.js",
		path: distDir,
	},
	cache: { type: "filesystem" },
	experiments: { asyncWebAssembly: true },
	resolve: {
		extensions: [".ts", ".tsx", ".js", ".json", ".less"],
		plugins: [new TsconfigPathsPlugin({ configFile: tsConfigPath })],
		fallback: {
			net: false,
			path: false,
			os: false,
			crypto: false,
			child_process: false,
			url: false,
			fs: false,
		},
	},
	mode: process.env["NODE_ENV"],
	devtool: "source-map",
	module: {
		exprContextCritical: false,
		rules: [
			{
				test: /\.tsx?$/,
				loader: "ts-loader",
				options: {
					happyPackMode: true,
					transpileOnly: true,
					configFile: tsConfigPath,
					compilerOptions: { target: "es2016" },
				},
			},
			{ test: /\.png$/, type: "asset/resource" },
			{ test: /\.css$/, use: [styleLoader, "css-loader"] },
			{
				test: /\.module\.less$/,
				use: [
					styleLoader,
					{
						loader: "css-loader",
						options: { sourceMap: true, modules: { localIdentName: "[local]___[hash:base64:5]" } },
					},
					{
						loader: "less-loader",
						options: { lessOptions: { javascriptEnabled: true } },
					},
				],
			},
			{
				test: /^((?!\.module).)*less$/,
				use: [
					styleLoader,
					{ loader: "css-loader" },
					{
						loader: "less-loader",
						options: { lessOptions: { javascriptEnabled: true } },
					},
				],
			},
			{
				test: /\.svg$/,
				type: "asset/resource",
				generator: { filename: "images/[name]-[hash:8][ext][query]" },
			},
			{
				test: /\.(woff(2)?|ttf|eot)(\?v=\d+\.\d+\.\d+)?$/,
				type: "asset/resource",
				generator: { filename: "fonts/[name]-[hash:8][ext][query]" },
			},
		],
	},
	resolveLoader: {
		modules: [path.resolve(__dirname, "../../../node_modules"), path.join(__dirname, "../node_modules"), "node_modules"],
		extensions: [".ts", ".tsx", ".js", ".json", ".less"],
		mainFields: ["loader", "main"],
	},
	plugins: [
		new HtmlWebpackPlugin({ template: path.join(publicDir, "index.html") }),
		new MiniCssExtractPlugin({ filename: "[name].[chunkhash:8].css", chunkFilename: "[id].css" }),
		!process.env.CI && new webpack.ProgressPlugin(),
		new NodePolyfillPlugin({ includeAliases: ["path", "Buffer", "process"] }),
		new webpack.DefinePlugin({
			"process.env.WORKSPACE_DIR": JSON.stringify(
				isDevelopment ? path.join(__dirname, "..", "workspace") : process.env["WORKSPACE_DIR"],
			),
			"process.env.EXTENSION_DIR": JSON.stringify(
				isDevelopment ? path.join(__dirname, "..", "extensions") : process.env["EXTENSION_DIR"],
			),
			"process.env.REVERSION": JSON.stringify(idePkg.version || "alpha"),
			"process.env.DEVELOPMENT": JSON.stringify(!!isDevelopment),
			"process.env.TEMPLATE_TYPE": JSON.stringify(isDevelopment ? process.env["TEMPLATE_TYPE"] : "standard"),
			// omp ACP agent 注册（正规偏好配置，非 provider patch）。
			"process.env.OMP_ACP_COMMAND": JSON.stringify(process.env.OMP_ACP_COMMAND || "bun"),
			"process.env.OMP_ACP_ARGS": JSON.stringify(
				process.env.OMP_ACP_ARGS || JSON.stringify([ompCliTs, "acp"]),
			),
		}),
		new CopyPlugin({
			patterns: [
				{
					from: publicDir,
					to: distDir,
					filter: (filepath) => !filepath.endsWith("index.html"),
				},
				{ from: monacoWorker, to: "editor.worker.bundle.js" },
			],
		}),
	],
	optimization: {
		nodeEnv: process.env.NODE_ENV,
		minimizer: [
			new TerserJSPlugin({ minify: TerserJSPlugin.esbuildMinify }),
			new OptimizeCSSAssetsPlugin({}),
		],
	},
	devServer: {
		static: { directory: path.join(__dirname, "../dist") },
		port,
		host: "0.0.0.0",
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
			"Access-Control-Allow-Headers": "X-Requested-With, content-type, Authorization",
		},
		open: true,
		client: { overlay: { errors: true, warnings: false, runtimeErrors: false } },
	},
};
