/** @type {import('next').NextConfig} */
const nextConfig = {
    async rewrites() {
        return [
          {
            source: '/ws/:path*',
            destination: 'http://localhost:8080/ws/:path*',
          },
          {
            source: '/sse/:path*',
            destination: 'http://localhost:8080/sse/:path*',
          },
          {
            source: '/stream/:path*',
            destination: 'http://localhost:8080/stream/:path*',
          }
        ]
      }
};

export default nextConfig;
