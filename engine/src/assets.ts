// Which arduino-cli Shibo downloads, for each kind of computer.

export const CLI_VERSION = '1.6.0';

/** The arduino-cli download for each kind of computer (platform-arch), with the SHA-256 from Arduino's 1.6.0-checksums.txt. */
export const CLI_ASSETS: Record<string, { file: string; sha256: string }> = {
  'linux-x64': { file: 'Linux_64bit.tar.gz', sha256: '321ee249f44c78053234fec0f36101092bc6021bf24939e15e0cc2449c5ed250' },
  'linux-arm64': { file: 'Linux_ARM64.tar.gz', sha256: '2ed4e1436bb3be1265966af8eba95dd25e28f3a9f92d0a58d371ed14dbaf550f' },
  'linux-arm': { file: 'Linux_ARMv7.tar.gz', sha256: '4936285be94c9327d8bc44124123789ed9bf6c0288bf826a4c2dd1ba98548667' },
  'darwin-x64': { file: 'macOS_64bit.tar.gz', sha256: 'af6a30cf5f57cc076b45fe55c6fd389440156f70706e7f8d3302a11a9fe32913' },
  'darwin-arm64': { file: 'macOS_ARM64.tar.gz', sha256: 'dc70f037fcbc8e7add892282bed5bab5eac317ff00bf0dd2f21e4a8e1d338a1c' },
  'win32-x64': { file: 'Windows_64bit.zip', sha256: '2769b9b282ce597db9679d8ec14d726d57004ca4205ef4d7a795bf36b6cdc9d8' },
  'win32-arm64': { file: 'Windows_ARM64.zip', sha256: 'ac31be09fcb5ca34af5450ba5a3106ea23394561d6a187cb9f4074756d18b0c6' },
};
