import { Event, OutputEvent } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import { DartDebugSession } from "./dart_debug_impl";
import { VMEvent } from "./dart_debug_protocol";
import { FlutterRun } from "./flutter_run";
import { FlutterLaunchRequestArguments } from "./utils";

export class FlutterDebugSession extends DartDebugSession {
	private flutter: FlutterRun;
	private currentRunningAppId: string;
	private appHasStarted = false;
	private observatoryUri: string;
	private noDebug: boolean;
	private isReloadInProgress: boolean;

	constructor() {
		super();

		this.sendStdOutToConsole = false;
	}

	protected initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments,
	): void {
		response.body.supportsRestartRequest = true;
		super.initializeRequest(response, args);
	}

	protected spawnProcess(args: FlutterLaunchRequestArguments): any {
		this.noDebug = args.noDebug;
		const debug = !args.noDebug;
		let appArgs = [];

		appArgs.push("-t");
		appArgs.push(this.sourceFileForArgs(args));

		if (args.deviceId) {
			appArgs.push("-d");
			appArgs.push(args.deviceId);
		}

		if (args.flutterMode === "profile") {
			appArgs.push("--profile");
		} else if (args.flutterMode === "release") {
			appArgs.push("--release");
		}

		if (debug) {
			appArgs.push("--start-paused");
		}

		if (args.args) {
			appArgs = appArgs.concat(args.args);
		}

		if (args.showMemoryUsage) {
			this.pollforMemoryMs = 1000;
		}

		// Normally for `flutter run` we don't allow terminating the pid we get from Observatory,
		// because it's on a remote device, however in the case of the flutter-tester, it is local
		// and otherwise might be left hanging around.
		this.allowTerminatingObservatoryVmPid = args.deviceId === "flutter-tester";

		const logger = (message: string) => this.sendEvent(new Event("dart.log.flutter.run", { message }));
		this.flutter = new FlutterRun(args.flutterPath, args.cwd, appArgs, args.flutterRunLogFile, logger);
		this.flutter.registerForUnhandledMessages((msg) => this.logToUser(msg));

		// Set up subscriptions.
		this.flutter.registerForDaemonConnect((n) => this.additionalPidsToTerminate.push(n.pid));
		this.flutter.registerForAppStart((n) => this.currentRunningAppId = n.appId);
		this.flutter.registerForAppDebugPort((n) => { this.observatoryUri = n.wsUri; });
		this.flutter.registerForAppStarted((n) => {
			this.appHasStarted = true;
			if (!args.noDebug && this.observatoryUri)
				this.initObservatory(this.observatoryUri);
		});
		this.flutter.registerForAppStop((n) => { this.currentRunningAppId = undefined; this.flutter.dispose(); });
		this.flutter.registerForAppProgress((e) => this.sendEvent(new Event("dart.progress", { message: e.message, finished: e.finished })));
		this.flutter.registerForError((err) => this.sendEvent(new OutputEvent(err, "stderr")));

		return this.flutter.process;
	}

	protected async disconnectRequest(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments,
	): Promise<void> {
		try {
			if (this.currentRunningAppId && this.appHasStarted)
				// Wait up to 500ms for app to quit since we often don't get a
				// response here because the processes terminate immediately.
				await Promise.race([
					this.flutter.stop(this.currentRunningAppId),
					new Promise((resolve) => setTimeout(resolve, 500)),
				]);
		} catch {
			// Ignore failures here (see comment above).
		}
		super.disconnectRequest(response, args);
	}

	protected restartRequest(
		response: DebugProtocol.RestartResponse,
		args: DebugProtocol.RestartArguments,
	): void {
		this.sendEvent(new Event("dart.restartRequest"));
		this.performReload(false);
		// Notify the Extension we had a restart request so it's able to
		// log the hotReload.
		super.restartRequest(response, args);
	}

	private async performReload(hotRestart: boolean): Promise<any> {
		if (!this.appHasStarted)
			return;

		if (this.isReloadInProgress) {
			this.sendEvent(new OutputEvent("Reload already in progress, ignoring request", "stderr"));
			return;
		}
		this.isReloadInProgress = true;
		try {
			await this.flutter.restart(this.currentRunningAppId, !this.noDebug, hotRestart);
			this.requestCoverageUpdate(hotRestart ? "hot-restart" : "hot-reload");
		} catch (e) {
			this.sendEvent(new OutputEvent(e, "stderr"));
		} finally {
			this.isReloadInProgress = false;
		}
	}

	protected async customRequest(request: string, response: DebugProtocol.Response, args: any): Promise<void> {
		try {
			switch (request) {
				case "serviceExtension":
					if (this.currentRunningAppId)
						await this.flutter.callServiceExtension(this.currentRunningAppId, args.type, args.params);
					break;

				case "togglePlatform":
					if (this.currentRunningAppId) {
						const result = await this.flutter.callServiceExtension(this.currentRunningAppId, "ext.flutter.platformOverride", null);
						await this.flutter.callServiceExtension(this.currentRunningAppId, "ext.flutter.platformOverride", { value: result.value === "android" ? "iOS" : "android" });
					}
					break;

				case "hotReload":
					if (this.currentRunningAppId)
						await this.performReload(false);
					break;

				case "hotRestart":
					if (this.currentRunningAppId)
						await this.performReload(true);
					break;

				default:
					super.customRequest(request, response, args);
					break;
			}
		} catch (e) {
			this.sendEvent(new OutputEvent(e, "stderr"));
		}
	}

	// Extension
	public handleExtensionEvent(event: VMEvent) {
		if (event.kind === "Extension" && event.extensionKind === "Flutter.FirstFrame") {
			this.sendEvent(new Event("dart.flutter.firstFrame", {}));
		} else if (event.kind === "Extension" && event.extensionKind === "Flutter.Frame") {
			this.requestCoverageUpdate("frame");
		} else {
			super.handleExtensionEvent(event);
		}
	}
}
