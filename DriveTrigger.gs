// CONFIGURATION
const FOLDER_ID = '1HuNlMGpo5z45oUwI8owlLbVPRUvPXPVD'; 
const CLOUD_FUNCTION_URL = 'https://ingest-drive-video-2t3s3mceqa-uc.a.run.app';
const BUCKET_NAME = 'ada-bucket';

// SECURITY: Define your secret key here
const API_SECRET_KEY = 'uvlkrVWJs9+YHA+8g1wXj3tda+IAxn9Bcg+Yxffd8oYwUMOkfPqDaoVyeYuOfVUA'; 

function doPost(e) {
  // LOGGING: Confirm execution started
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

    // 2. Run the check logic
    const shouldReset = requestBody.reset_timer === true;
    const scanAllFolders = requestBody.scan_all_folders === true;
    
    console.log(`Starting checkNewFiles. Reset: ${shouldReset}, ScanAll: ${scanAllFolders}`);
    const data = checkNewFiles(shouldReset, scanAllFolders);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      new_files: data.map(item => item.uri),
      transcript_exists: data.map(item => item.transcript_exists),
      transcript_contents: data.map(item => item.content),
      source_folders: data.map(item => item.folderUrl),
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

function checkNewFiles(shouldReset, scanAllFolders) {
  const props = PropertiesService.getScriptProperties();
  let lastCheck = props.getProperty('LAST_CHECK_TIME');
  
  let startTime;
  if (shouldReset) {
    startTime = new Date(new Date().getTime() - 90 * 24 * 60 * 60 * 1000); 
    props.deleteProperty('LAST_CHECK_TIME');
  } else if (!lastCheck) {
    startTime = new Date(new Date().getTime() - 90 * 24 * 60 * 60 * 1000); 
  } else {
    startTime = new Date(lastCheck);
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
    
    if (scanAllFolders || folderCreated > startTime) {
        
        debugLogs.push(`[MATCH] Entering folder: ${folderName}`);
        
        const folderUrl = folder.getUrl();
        // Pass debugLogs to helper
        const content = getFolderContents(folder, debugLogs); 
        const transcriptFile = content.transcriptFile;

        // STRICT LOGIC: ONLY Process if Transcript Exists
        if (transcriptFile) {
             const transcriptContent = transcriptFile.getBlob().getDataAsString();
             // Ingest transcript file
             const gcsUri = triggerIngestion(transcriptFile, transcriptFile.getName(), folderUrl, debugLogs);
             
             if (gcsUri) {
               results.push({
                 uri: gcsUri,
                 transcript_exists: true,
                 content: transcriptContent,
                 folderUrl: folderUrl
               });
               debugLogs.push(`[INGEST] Successfully processed transcript for ${folderName}`);
             }
        } else {
            // If no transcript, we do NOTHING. We do not look for videos.
            debugLogs.push(`[SKIP] No transcript found in ${folderName}. Skipping.`);
        }
    }
  }
  
  results.logs = debugLogs;
  return results;
}

function getFolderContents(folder, debugLogs) {
  const filesIterator = folder.getFiles();
  let transcriptFile = null;

  while (filesIterator.hasNext()) {
    const file = filesIterator.next();
    const name = file.getName();
    const lowerName = name.toLowerCase();
    
    // STRICT FILTER: Only look for transcripts ending in transcript.vtt
    if (lowerName.endsWith('transcript.vtt')) {
      transcriptFile = file;
      debugLogs.push(`  -> Found Transcript: ${name}`);
    } 
    // Note: We intentionally ignore .mp4 files here now.
  }
  
  return { 
    transcriptFile: transcriptFile
  };
}

function triggerIngestion(file, targetName, folderUrl, debugLogs) {
  const payload = {
    driveFileId: file.getId(),
    bucketName: BUCKET_NAME,
    fileName: targetName || file.getName(),
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
        console.error(err);
        if (debugLogs) debugLogs.push(`[ERROR] ${err}`);
        return null;
      }
    } else {
      const err = `Ingester failed (${statusCode}): ${content}`;
      console.error(err);
      if (debugLogs) debugLogs.push(`[ERROR] ${err}`);
      return null;
    }
  } catch (e) {
    const err = `Failed to call Ingester for ${file.getName()}: ${e}`;
    console.error(err);
    if (debugLogs) debugLogs.push(`[EXCEPTION] ${err}`);
    return null;
  }
}
