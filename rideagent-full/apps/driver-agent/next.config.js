/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rideagent/shared"],
  env: {
    RIDER_AGENT_URL: process.env.RIDER_AGENT_URL || "http://localhost:3000",
  },
};
module.exports = nextConfig;
