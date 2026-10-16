/**
 * IP utility functions for session binding and security.
 * Extracts IP subnets for security fingerprinting.
 */

/**
 * Normalize and extract the IP subnet from a request.
 * Handles IPv4 addresses by extracting the first 3 octets (class C /24 subnet).
 * For IPv6 or unrecognized formats, returns the full IP.
 *
 * Examples:
 *   "192.168.1.100" -> "192.168.1"
 *   "10.0.0.5" -> "10.0.0"
 *   "2001:db8::1" -> "2001:db8::1" (IPv6 returned as-is for now)
 *   "127.0.0.1" -> "127.0.0.1" (localhost)
 *
 * @param {string} ip - Client IP address
 * @returns {string} IP subnet or full IP
 */
function extractIpSubnet(ip) {
	if (ip === null || ip === undefined) return null;
	if (typeof ip !== "string") return null;

	// Trim whitespace
	ip = ip.trim();

	// IPv4: extract first 3 octets for /24 subnet
	if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
		const parts = ip.split(".");
		if (parts.length === 4) {
			return `${parts[0]}.${parts[1]}.${parts[2]}`;
		}
	}

	// IPv6 or other: return as-is for now
	return ip;
}

/**
 * Get the client IP from an Express request, handling proxies and headers.
 * Checks X-Forwarded-For, CF-Connecting-IP, and falls back to remoteAddress.
 *
 * @param {object} req - Express request object
 * @returns {string} Client IP address or null
 */
function getClientIp(req) {
	if (!req) return null;

	// X-Forwarded-For (may contain multiple IPs: client, proxy1, proxy2, ...)
	const xForwardedFor = req.headers["x-forwarded-for"];
	if (xForwardedFor) {
		const ips = xForwardedFor.split(",");
		const clientIp = ips[0].trim();
		if (clientIp) return clientIp;
	}

	// Cloudflare
	const cfConnectingIp = req.headers["cf-connecting-ip"];
	if (cfConnectingIp) return cfConnectingIp.trim();

	// Direct connection
	if (req.socket?.remoteAddress) {
		return req.socket.remoteAddress;
	}

	if (req.connection?.remoteAddress) {
		return req.connection.remoteAddress;
	}

	return null;
}

/**
 * Extract and normalize IP subnet from request.
 * Combines getClientIp and extractIpSubnet for convenience.
 *
 * @param {object} req - Express request object
 * @returns {string} IP subnet or null
 */
function getIpSubnetFromRequest(req) {
	const ip = getClientIp(req);
	return ip ? extractIpSubnet(ip) : null;
}

module.exports = {
	extractIpSubnet,
	getClientIp,
	getIpSubnetFromRequest,
};
