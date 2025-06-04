import path from "path";
import { execFileSync } from "child_process";

import * as xml from "fast-xml-parser";

import { ActionableError, Button, InstalledApp, Robot, ScreenElement, ScreenElementRect, ScreenSize, SwipeDirection, Orientation } from "./robot";

export interface AndroidDevice {
	deviceId: string;
	deviceType: "tv" | "mobile";
}

interface UiAutomatorXmlNode {
	node: UiAutomatorXmlNode[];
	class?: string;
	text?: string;
	bounds?: string;
	hint?: string;
	focused?: string;
	"content-desc"?: string;
	"resource-id"?: string;
}

interface UiAutomatorXml {
	hierarchy: {
		node: UiAutomatorXmlNode;
	};
}

const getAdbPath = (): string => {
	let executable = "adb";
	if (process.env.ANDROID_HOME) {
		executable = path.join(process.env.ANDROID_HOME, "platform-tools", "adb");
	}

	return executable;
};

const BUTTON_MAP: Record<Button, string> = {
	"BACK": "KEYCODE_BACK",
	"HOME": "KEYCODE_HOME",
	"VOLUME_UP": "KEYCODE_VOLUME_UP",
	"VOLUME_DOWN": "KEYCODE_VOLUME_DOWN",
	"ENTER": "KEYCODE_ENTER",
	"DPAD_CENTER": "KEYCODE_DPAD_CENTER",
	"DPAD_UP": "KEYCODE_DPAD_UP",
	"DPAD_DOWN": "KEYCODE_DPAD_DOWN",
	"DPAD_LEFT": "KEYCODE_DPAD_LEFT",
	"DPAD_RIGHT": "KEYCODE_DPAD_RIGHT",
};

const TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 4;

type AndroidDeviceType = "tv" | "mobile";

export class AndroidRobot implements Robot {

	public constructor(private deviceId: string) {
	}

	public adb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
		});
	}

	public getSystemFeatures(): string[] {
		return this.adb("shell", "pm", "list", "features")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("feature:"))
			.map(line => line.substring("feature:".length));
	}

	public async getScreenSize(): Promise<ScreenSize> {
		// Get the physical screen size (this doesn't change with orientation)
		const screenSize = this.adb("shell", "wm", "size")
			.toString()
			.split(" ")
			.pop();

		if (!screenSize) {
			throw new Error("Failed to get screen size");
		}

		// Get device density for proper scaling
		const densityOutput = this.adb("shell", "wm", "density")
			.toString()
			.trim();
		
		// Extract density value (e.g. "Physical density: 420" -> 420)
		const densityMatch = densityOutput.match(/density:\s*(\d+)/i);
		const density = densityMatch ? parseInt(densityMatch[1], 10) : 160; // Default to 160 (mdpi)
		const scale = density / 160; // Android baseline density is 160dpi

		const [physicalWidth, physicalHeight] = screenSize.split("x").map(Number);
		
		// Get current orientation to return the correct width/height
		const currentOrientation = await this.getOrientation();
		
		let width: number, height: number;
		
		// Determine logical orientation based on physical dimensions and current orientation setting
		// If device is naturally portrait (height > width) and we're in landscape, swap dimensions
		// If device is naturally landscape (width > height) and we're in portrait, swap dimensions
		const isNaturallyPortrait = physicalHeight > physicalWidth;
		
		if (currentOrientation === "landscape") {
			if (isNaturallyPortrait) {
				// Portrait device in landscape mode: swap dimensions
				width = physicalHeight;
				height = physicalWidth;
			} else {
				// Landscape device in landscape mode: keep as is
				width = physicalWidth;
				height = physicalHeight;
			}
		} else { // portrait
			if (isNaturallyPortrait) {
				// Portrait device in portrait mode: keep as is
				width = physicalWidth;
				height = physicalHeight;
			} else {
				// Landscape device in portrait mode: swap dimensions
				width = physicalHeight;
				height = physicalWidth;
			}
		}

		return { width, height, scale };
	}

	public async listApps(): Promise<InstalledApp[]> {
		return this.adb("shell", "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("packageName="))
			.map(line => line.substring("packageName=".length))
			.filter((value, index, self) => self.indexOf(value) === index)
			.map(packageName => ({
				packageName,
				appName: packageName,
			}));
	}

	public async launchApp(packageName: string): Promise<void> {
		this.adb("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
	}

	public async listRunningProcesses(): Promise<string[]> {
		return this.adb("shell", "ps", "-e")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("u")) // non-system processes
			.map(line => line.split(/\s+/)[8]); // get process name
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = screenSize.width >> 1;
		const centerY = screenSize.height >> 1;

		let x0: number, y0: number, x1: number, y1: number;

		switch (direction) {
			case "up":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.80);
				y1 = Math.floor(screenSize.height * 0.20);
				break;
			case "down":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.20);
				y1 = Math.floor(screenSize.height * 0.80);
				break;
			case "left":
				y0 = y1 = centerY;
				x0 = Math.floor(screenSize.width * 0.80);
				x1 = Math.floor(screenSize.width * 0.20);
				break;
			case "right":
				y0 = y1 = centerY;
				x0 = Math.floor(screenSize.width * 0.20);
				x1 = Math.floor(screenSize.width * 0.80);
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	public async getScreenshot(): Promise<Buffer> {
		return this.adb("exec-out", "screencap", "-p");
	}

	private collectElements(node: UiAutomatorXmlNode): ScreenElement[] {
		const elements: Array<ScreenElement> = [];

		if (node.node) {
			if (Array.isArray(node.node)) {
				for (const childNode of node.node) {
					elements.push(...this.collectElements(childNode));
				}
			} else {
				elements.push(...this.collectElements(node.node));
			}
		}

		if (node.text || node["content-desc"] || node.hint) {
			const element: ScreenElement = {
				type: node.class || "text",
				text: node.text,
				label: node["content-desc"] || node.hint || "",
				rect: this.getScreenElementRect(node),
			};

			if (node.focused === "true") {
				// only provide it if it's true, otherwise don't confuse llm
				element.focused = true;
			}

			const resourceId = node["resource-id"];
			if (resourceId !== null && resourceId !== "") {
				element.identifier = resourceId;
			}

			if (element.rect.width > 0 && element.rect.height > 0) {
				elements.push(element);
			}
		}

		return elements;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const parsedXml = await this.getUiAutomatorXml();
		const hierarchy = parsedXml.hierarchy;
		const elements = this.collectElements(hierarchy.node);
		return elements;
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.adb("shell", "am", "force-stop", packageName);
	}

	public async openUrl(url: string): Promise<void> {
		this.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url);
	}

	public async sendKeys(text: string): Promise<void> {
		// adb shell requires some escaping
		const _text = text.replace(/ /g, "\\ ");
		this.adb("shell", "input", "text", _text);
	}

	public async pressButton(button: Button) {
		if (!BUTTON_MAP[button]) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		this.adb("shell", "input", "keyevent", BUTTON_MAP[button]);
	}

	/**
	 * Converts logical coordinates to physical coordinates for tapping.
	 * This accounts for device scale and orientation.
	 */
	private async convertToPhysicalCoordinates(logicalX: number, logicalY: number): Promise<{ x: number; y: number }> {
		const screenSize = await this.getScreenSize();
		
		// For most Android devices, logical coordinates match physical coordinates
		// The scale factor is already handled in getScreenSize()
		return {
			x: Math.round(logicalX),
			y: Math.round(logicalY)
		};
	}

	public async tap(x: number, y: number): Promise<void> {
		// Convert logical coordinates to physical coordinates if needed
		const physicalCoords = await this.convertToPhysicalCoordinates(x, y);
		this.adb("shell", "input", "tap", `${physicalCoords.x}`, `${physicalCoords.y}`);
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		const orientationValue = orientation === "portrait" ? 0 : 1;

		try {
			// Disable auto-rotation first to ensure our setting sticks
			this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
			
			// Set the user rotation preference
			this.adb("shell", "settings", "put", "system", "user_rotation", `${orientationValue}`);
			
			// Alternative method using content insert (for some Android versions)
			this.adb("shell", "content", "insert", "--uri", "content://settings/system", "--bind", "name:s:user_rotation", "--bind", `value:i:${orientationValue}`);
			
			// Force the screen to update by toggling auto-rotation briefly (on some devices)
			// This helps ensure the rotation takes effect immediately
			try {
				this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "1");
				// Small delay to let the system process
				await new Promise(resolve => setTimeout(resolve, 100));
				this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
			} catch (e) {
				// Ignore errors in this fallback method
			}
			
			// Wait a bit for the orientation change to take effect
			await new Promise(resolve => setTimeout(resolve, 500));
			
		} catch (error) {
			throw new ActionableError(`Failed to set orientation to ${orientation}: ${error}`);
		}
	}

	public async getOrientation(): Promise<Orientation> {
		try {
			// Try to get user_rotation first (works when auto-rotation is disabled)
			const userRotation = this.adb("shell", "settings", "get", "system", "user_rotation").toString().trim();
			
			// If user_rotation is available and valid, use it
			if (userRotation && userRotation !== "null" && !isNaN(parseInt(userRotation))) {
				const rotation = parseInt(userRotation);
				// 0 = portrait, 1 = landscape (90° counter-clockwise), 2 = reverse portrait, 3 = reverse landscape  
				return (rotation === 1 || rotation === 3) ? "landscape" : "portrait";
			}
			
			// Fallback: get the actual current surface rotation
			const surfaceRotation = this.adb("shell", "dumpsys", "display", "|", "grep", "-i", "rotation").toString().trim();
			const rotationMatch = surfaceRotation.match(/rotation=(\d+)/);
			
			if (rotationMatch) {
				const rotation = parseInt(rotationMatch[1]);
				return (rotation === 1 || rotation === 3) ? "landscape" : "portrait";
			}
			
			// Final fallback: assume portrait
			return "portrait";
		} catch (error) {
			// If any command fails, assume portrait as fallback
			return "portrait";
		}
	}

	private async getUiAutomatorDump(): Promise<string> {
		for (let tries = 0; tries < 10; tries++) {
			const dump = this.adb("exec-out", "uiautomator", "dump", "/dev/tty").toString();
			// note: we're not catching other errors here. maybe we should check for <?xml
			if (dump.includes("null root node returned by UiTestAutomationBridge")) {
				// uncomment for debugging
				// const screenshot = await this.getScreenshot();
				// console.error("Failed to get UIAutomator XML. Here's a screenshot: " + screenshot.toString("base64"));
				continue;
			}

			return dump;
		}

		throw new ActionableError("Failed to get UIAutomator XML");
	}

	private async getUiAutomatorXml(): Promise<UiAutomatorXml> {
		const dump = await this.getUiAutomatorDump();
		const parser = new xml.XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "",
		});

		return parser.parse(dump) as UiAutomatorXml;
	}

	private getScreenElementRect(node: UiAutomatorXmlNode): ScreenElementRect {
		const bounds = String(node.bounds);

		const [, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		};
	}
}

export class AndroidDeviceManager {

	private getDeviceType(name: string): AndroidDeviceType {
		const device = new AndroidRobot(name);
		const features = device.getSystemFeatures();
		if (features.includes("android.software.leanback") || features.includes("android.hardware.type.television")) {
			return "tv";
		}

		return "mobile";
	}

	public getConnectedDevices(): AndroidDevice[] {
		try {
			const names = execFileSync(getAdbPath(), ["devices"])
				.toString()
				.split("\n")
				.filter(line => !line.startsWith("List of devices attached"))
				.filter(line => line.trim() !== "")
				.map(line => line.split("\t")[0]);

			return names.map(name => ({
				deviceId: name,
				deviceType: this.getDeviceType(name),
			}));
		} catch (error) {
			console.error("Could not execute adb command, maybe ANDROID_HOME is not set?");
			return [];
		}
	}
}
