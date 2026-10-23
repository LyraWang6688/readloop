import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Docker 部署用 standalone 产物（见 Dockerfile）：.next/standalone + .next/static
  output: 'standalone',
  allowedDevOrigins: ['*.dev.coze.site'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
