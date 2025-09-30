import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/sse/:path*',
        destination: 'http://localhost:8080/sse/:path*',
      },
      {
        source: '/stream/:path*',
        destination: 'http://localhost:8080/stream/:path*',
      },
      {
        source: '/ws/:path*',
        destination: 'http://localhost:8080/ws/:path*',
      },
      {
        source: '/ping',
        destination: 'http://localhost:8080/ping',
      },
    ];
  },
};

export default nextConfig;
