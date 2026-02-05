// CONFIGURATION
const FOLDER_ID = '1HuNlMGpo5z45oUwI8owlLbVPRUvPXPVD'; 
const CLOUD_FUNCTION_URL = 'https://ingest-drive-video-2t3s3mceqa-uc.a.run.app';
const BUCKET_NAME = 'ada-bucket';

// SECURITY: Define your secret key here
const API_SECRET_KEY = 'Replace with KEY'; 

/**
 * Main entry point for the Web App. Handles POST requests from Elastic Workflows.
 */
function doPost(e) {
  console.log("doPost triggered");

  try {
    // 1. SECURITY CHECK
    if (!e || !e.postData || !e.postData.contents) {
      console.error("Invalid Request: No body provided");
      throw new Error("Invalid Request: No body provided");
    }

    const requestBody = JSON.parse(e.postData.contents);

    if (requestBody.secret_key !== API_SECRET_KEY) {
      console.error("Unauthorized access attempt");
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'Unauthorized: Invalid or missing secret key'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. PARSE INPUTS
    const shouldReset = requestBody.reset_timer === true;
    const scanAllFolders = requestBody.scan_all_folders === true;
    const folderStartsWith = requestBody.folderStartsWith; // e.g. "2025-01"
    
    console.log(`Starting checkNewFiles. Reset: ${shouldReset}, ScanAll: ${scanAllFolders}, Prefix: ${folderStartsWith}`);
    const data = checkNewFiles(shouldReset, scanAllFolders, folderStartsWith);
    
    // 3. RETURN STRUCTURED DATA
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      new_files: data.map(item => item.uri),
      transcript_exists: data.map(item => item.transcript_exists),
      transcript_contents: data.map(item => item.content),
      source_folders: data.map(item => item.folderUrl),
      video_drive_urls: data.map(item => item.videoUrl),
      logs: data.logs 
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    console.error(`Error in doPost: ${err.toString()}`);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Logic to find and process new folders/files in Google Drive.
 */
function checkNewFiles(shouldReset, scanAllFolders, folderStartsWith) {
  const props = PropertiesService.getScriptProperties();
  let lastCheck = props.getProperty('LAST_CHECK_TIME');
  
  let startTime;

  // LOOKBACK LOGIC
  if (folderStartsWith) {
    // Case A: Specific Folder Search -> Scan back 90 days to ensure it is found
    startTime = new Date(new Date().getTime() - 90 * 24 * 60 * 60 * 1000); 
  } else if (shouldReset) {
    // Case B: Reset Requested -> Scan back 7 days to capture recent missed data
    startTime = new Date(new Date().getTime() - 7 * 24 * 60 * 60 * 1000); 
    props.deleteProperty('LAST_CHECK_TIME');
  } else {
    // Case C: Standard Run -> Default to 24 hours lookback
    startTime = new Date(new Date().getTime() - 24 * 60 * 60 * 1000); 
  }
  
  props.setProperty('LAST_CHECK_TIME', new Date().toISOString());
  
  const parentFolder = DriveApp.getFolderById(FOLDER_ID);
  const subFolders = parentFolder.getFolders();
  const results = [];
  const debugLogs = []; 
  
  debugLogs.push(`Scanning parent: ${parentFolder.getName()}`);
  debugLogs.push(`Cutoff Time: ${startTime.toISOString()}`);

  while (subFolders.hasNext()) {
    const folder = subFolders.next();
    const folderName = folder.getName();
    const folderCreated = folder.getDateCreated();
    
    // 1. Prefix Filter
    if (folderStartsWith && !folderName.startsWith(folderStartsWith)) {
      continue; 
    }

    // 2. Creation Date Filter (Unless prefix or scan_all is enabled)
    if (scanAllFolders || folderStartsWith || folderCreated > startTime) {
        
        debugLogs.push(`[MATCH] Entering folder: ${folderName}`);
        
        const folderUrl = folder.getUrl();
        const content = getFolderContents(folder, debugLogs); 
        const transcriptFiles = content.transcriptFiles; 
        const videoFiles = content.videoFiles; 

        if (transcriptFiles && transcriptFiles.length > 0) {
             
             // Process every transcript found in the subfolder
             for (const tFile of transcriptFiles) {
                 const transcriptContent = tFile.getBlob().getDataAsString();
                 const tName = tFile.getName();
                 
                 // IMPROVED: Match video by name prefix to ensure uniqueness
                 const baseName = tName.replace('.transcript.vtt', '');
                 let matchingVideo = videoFiles.find(v => v.getName().toLowerCase().startsWith(baseName.toLowerCase()));
                 
                 let videoUrl = null;
                 if (matchingVideo) {
                   videoUrl = matchingVideo.getUrl();
                   debugLogs.push(`  -> Linked transcript ${tName} to specific video: ${matchingVideo.getName()}`);
                 } else if (videoFiles.length > 0) {
                   videoUrl = videoFiles[0].getUrl();
                   debugLogs.push(`  -> No direct match for ${tName}. Using first video in folder.`);
                 }

                 // CRITICAL: Prepend Folder Name to prevent GCS Overwrites
                 const uniqueTargetName = `${folderName}_${tName}`;

                 const gcsUri = triggerIngestion(tFile, uniqueTargetName, folderUrl, debugLogs);
                 
                 if (gcsUri) {
                   results.push({
                     uri: gcsUri,
                     transcript_exists: true,
                     content: transcriptContent,
                     folderUrl: folderUrl,
                     videoUrl: videoUrl 
                   });
                   debugLogs.push(`[INGEST] Successfully processed ${tName} as ${uniqueTargetName}`);
                 }
             }
        } else {
            debugLogs.push(`[SKIP] No transcript found in ${folderName}.`);
        }
    } else {
        debugLogs.push(`[SKIP] Folder ${folderName} created at ${folderCreated.toISOString()} is older than cutoff.`);
    }
  }
  
  results.logs = debugLogs;
  return results;
}

/**
 * Helper to get specific file types from a folder.
 */
function getFolderContents(folder, debugLogs) {
  const filesIterator = folder.getFiles();
  const transcriptFiles = []; 
  const videoFiles = [];

  while (filesIterator.hasNext()) {
    const file = filesIterator.next();
    const name = file.getName();
    const lowerName = name.toLowerCase();
    const mimeType = file.getMimeType();
    
    // Identify Transcript
    if (lowerName.endsWith('transcript.vtt')) {
      transcriptFiles.push(file);
      debugLogs.push(`  -> Found Transcript: ${name}`);
    } 
    // Identify Video
    else if (mimeType === 'video/mp4' || lowerName.endsWith('.mp4')) {
      videoFiles.push(file);
      debugLogs.push(`  -> Found Video: ${name}`);
    }
  }
  
  return { 
    transcriptFiles: transcriptFiles,
    videoFiles: videoFiles
  };
}

/**
 * Helper to call the GCF Ingester.
 */
function triggerIngestion(file, targetName, folderUrl, debugLogs) {
  const payload = {
    driveFileId: file.getId(),
    bucketName: BUCKET_NAME,
    fileName: targetName,
    driveFolderUrl: folderUrl 
  };

  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'payload': JSON.stringify(payload),
    'muteHttpExceptions': true
  };

  try {
    const response = UrlFetchApp.fetch(CLOUD_FUNCTION_URL, options);
    const statusCode = response.getResponseCode();
    const content = response.getContentText();
    
    if (statusCode === 200) {
      const json = JSON.parse(content);
      if (json.gcsUri) {
        return json.gcsUri;
      } else {
        const err = `Ingester returned 200 but no gcsUri: ${content}`;
        if (debugLogs) debugLogs.push(`[ERROR] ${err}`);
        return null;
      }
    } else {
      const err = `Ingester failed (${statusCode}): ${content}`;
      if (debugLogs) debugLogs.push(`[ERROR] ${err}`);
      return null;
    }
  } catch (e) {
    const err = `Failed to call Ingester for ${file.getName()}: ${e}`;
    if (debugLogs) debugLogs.push(`[EXCEPTION] ${err}`);
    return null;
  }
}
