import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the dev badge sits on top of the sidebar usage card
  devIndicators: false,
  // public.ps1 builds the public site into a separate folder while the running one keeps serving
  distDir: process.env.BLUESANDAI_NEXT_DIST || ".next",
  // clickjacking, MIME sniffing and referrer leaks (the API sets its own headers)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self), payment=()" },
          ...(process.env.BLUESANDAI_HSTS === "1" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
