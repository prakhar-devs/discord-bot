import { uploadVideoInChunks } from './videoChunkUploader.ts';

// You can change this to the exact name of the file you put in input_videos/
const TEST_FILE = './input_videos/test.mp4';

async function runTest() {
  console.log(`🚀 Starting Video Splitter Test Mode for: ${TEST_FILE}\n`);
  
  try {
    await uploadVideoInChunks({
      inputPath: TEST_FILE,
      channel: null, // Not needed because we are skipping Discord upload
      maxChunkSizeMB: 9,
      enableTestMode: true // 👈 This is the magic flag!
    });
    
    console.log('\n✅ Test execution finished successfully.');
  } catch (error) {
    console.error('\n❌ Test execution failed:', error.message);
  }
}

runTest();
