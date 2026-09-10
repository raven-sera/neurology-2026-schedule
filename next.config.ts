import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  trailingSlash: true,
  images: { unoptimized: true },
  // The editable check-in phrase corpus is bundled locally.
  webpack(config) {
    config.module.rules.push({ test: /\.md$/, resourceQuery: /raw/, type: 'asset/source' });
    return config;
  },
};

export default nextConfig;
