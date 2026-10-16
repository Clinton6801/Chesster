const { extractIpSubnet, getClientIp, getIpSubnetFromRequest } = require("../utils/ipUtils");

describe("ipUtils", () => {
	describe("extractIpSubnet", () => {
		test("extracts /24 subnet from IPv4 address", () => {
			expect(extractIpSubnet("192.168.1.100")).toBe("192.168.1");
			expect(extractIpSubnet("10.0.0.5")).toBe("10.0.0");
			expect(extractIpSubnet("172.16.50.200")).toBe("172.16.50");
		});

		test("handles localhost", () => {
			expect(extractIpSubnet("127.0.0.1")).toBe("127.0.0");
		});

		test("handles public IPs", () => {
			expect(extractIpSubnet("8.8.8.8")).toBe("8.8.8");
			expect(extractIpSubnet("1.1.1.1")).toBe("1.1.1");
		});

		test("returns full IPv6 as-is", () => {
			expect(extractIpSubnet("2001:db8::1")).toBe("2001:db8::1");
			expect(extractIpSubnet("::1")).toBe("::1");
		});

		test("handles null/undefined input", () => {
			expect(extractIpSubnet(null)).toBeNull();
			expect(extractIpSubnet(undefined)).toBeNull();
		});

		test("trims whitespace", () => {
			expect(extractIpSubnet("  192.168.1.100  ")).toBe("192.168.1");
			expect(extractIpSubnet("\n10.0.0.5\t")).toBe("10.0.0");
		});

		test("handles malformed IPs gracefully", () => {
			expect(extractIpSubnet("invalid")).toBe("invalid");
			expect(extractIpSubnet("192.168")).toBe("192.168");
			expect(extractIpSubnet("")).toBe("");
		});
	});

	describe("getClientIp", () => {
		test("extracts IP from X-Forwarded-For header (first IP)", () => {
			const req = {
				headers: {
					"x-forwarded-for": "203.0.113.1, 198.51.100.2, 192.0.2.3",
				},
			};
			expect(getClientIp(req)).toBe("203.0.113.1");
		});

		test("uses CF-Connecting-IP when X-Forwarded-For is absent", () => {
			const req = {
				headers: {
					"cf-connecting-ip": "104.16.0.1",
				},
			};
			expect(getClientIp(req)).toBe("104.16.0.1");
		});

		test("prefers X-Forwarded-For over CF-Connecting-IP", () => {
			const req = {
				headers: {
					"x-forwarded-for": "203.0.113.1",
					"cf-connecting-ip": "104.16.0.1",
				},
			};
			expect(getClientIp(req)).toBe("203.0.113.1");
		});

		test("extracts from socket.remoteAddress when no headers", () => {
			const req = {
				headers: {},
				socket: {
					remoteAddress: "192.168.1.100",
				},
			};
			expect(getClientIp(req)).toBe("192.168.1.100");
		});

		test("falls back to connection.remoteAddress", () => {
			const req = {
				headers: {},
				connection: {
					remoteAddress: "10.0.0.50",
				},
			};
			expect(getClientIp(req)).toBe("10.0.0.50");
		});

		test("returns null when no IP sources available", () => {
			const req = {
				headers: {},
			};
			expect(getClientIp(req)).toBeNull();
		});

		test("returns null for null request", () => {
			expect(getClientIp(null)).toBeNull();
		});

		test("trims whitespace from X-Forwarded-For", () => {
			const req = {
				headers: {
					"x-forwarded-for": "  203.0.113.1  , 198.51.100.2",
				},
			};
			expect(getClientIp(req)).toBe("203.0.113.1");
		});
	});

	describe("getIpSubnetFromRequest", () => {
		test("extracts and normalizes IP subnet from request", () => {
			const req = {
				headers: {
					"x-forwarded-for": "192.168.1.100",
				},
			};
			expect(getIpSubnetFromRequest(req)).toBe("192.168.1");
		});

		test("handles proxy chain and extracts first IP subnet", () => {
			const req = {
				headers: {
					"x-forwarded-for": "203.0.113.50, 198.51.100.2, 192.0.2.3",
				},
			};
			expect(getIpSubnetFromRequest(req)).toBe("203.0.113");
		});

		test("returns null when no IP available", () => {
			const req = {
				headers: {},
			};
			expect(getIpSubnetFromRequest(req)).toBeNull();
		});

		test("returns null for null request", () => {
			expect(getIpSubnetFromRequest(null)).toBeNull();
		});

		test("works with direct socket connection", () => {
			const req = {
				headers: {},
				socket: {
					remoteAddress: "10.0.0.100",
				},
			};
			expect(getIpSubnetFromRequest(req)).toBe("10.0.0");
		});
	});

	describe("Integration: Real-world scenarios", () => {
		test("handles corporate proxy chain", () => {
			const req = {
				headers: {
					"x-forwarded-for": "10.20.30.40, 10.20.30.1, 192.168.1.1",
				},
			};
			const subnet = getIpSubnetFromRequest(req);
			expect(subnet).toBe("10.20.30");
		});

		test("handles Cloudflare + corporate proxy", () => {
			const req = {
				headers: {
					"cf-connecting-ip": "104.16.132.1",
					"x-forwarded-for": "203.0.113.100",
				},
			};
			const subnet = getIpSubnetFromRequest(req);
			// X-Forwarded-For takes precedence
			expect(subnet).toBe("203.0.113");
		});

		test("handles localhost development environment", () => {
			const req = {
				headers: {},
				socket: {
					remoteAddress: "127.0.0.1",
				},
			};
			const subnet = getIpSubnetFromRequest(req);
			expect(subnet).toBe("127.0.0");
		});
	});
});
