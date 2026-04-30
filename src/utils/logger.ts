export const Logger = {
  info: (message: string, prefix = 'ℹ️') => {
    console.log(`${prefix} ${message}`);
  },
  warn: (message: string) => {
    console.warn(`⚠️  ${message}`);
  },
  error: (message: string, error?: any) => {
    console.error(`❌ ${message}${error ? `: ${error.message || error}` : ''}`);
  },
  success: (message: string) => {
    console.log(`✅ ${message}`);
  },
  debug: (message: string) => {
    if (process.env.DEBUG) {
      console.log(`🔍 [DEBUG] ${message}`);
    }
  }
};
