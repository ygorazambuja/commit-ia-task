import { describe, expect, test } from "bun:test";
import { formatDuration, formatFileSize } from "../src/logger";

describe("logger format helpers", () => {
	test("formats durations using the expected unit thresholds", () => {
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(90000)).toBe("1.5min");
	});

	test("formats file sizes using the expected unit thresholds", () => {
		expect(formatFileSize(1023)).toBe("1023B");
		expect(formatFileSize(1536)).toBe("1.5KB");
		expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0MB");
	});
});
