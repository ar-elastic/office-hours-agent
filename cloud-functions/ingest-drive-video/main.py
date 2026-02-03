import functions_framework
from google.cloud import storage
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import google.auth
import os
import tempfile

@functions_framework.http
def ingest_and_forward(request):
    try:
        request_json = request.get_json()
        
        drive_file_id = request_json.get('driveFileId')
        bucket_name = request_json.get('bucketName')
        file_name = request_json.get('fileName', 'ingested_video.mp4')

        if not all([drive_file_id, bucket_name]):
            return {"error": "Missing driveFileId or bucketName"}, 400

        print(f"Starting ingestion for Drive ID: {drive_file_id}")

        # 1. Setup Drive Client with EXPLICIT Scope
        SCOPES = ['https://www.googleapis.com/auth/drive']
        creds, _ = google.auth.default(scopes=SCOPES)
        service = build('drive', 'v3', credentials=creds)

        # 2. Get Metadata
        # We use supportsAllDrives=True to ensure we can see files in shared drives/folders
        try:
            file_metadata = service.files().get(
                fileId=drive_file_id, 
                supportsAllDrives=True
            ).execute()
        except Exception as e:
            print(f"Error getting metadata for {drive_file_id}: {e}")
            # If we can't even get metadata, it's definitely a permission issue.
            return {"error": f"Permission Denied or File Not Found: {e}"}, 500
        
        mime_type = file_metadata.get('mimeType', 'video/mp4')
        print(f"Found file: {file_metadata.get('name')} ({mime_type})")

        _, temp_local_path = tempfile.mkstemp()
        
        # 3. Download Content
        # FIX: Use files().get_media() properly with supportsAllDrives implied
        request_drive = service.files().get_media(fileId=drive_file_id)
        
        # Note: If the file is a Google Doc/Sheet/Slide, get_media will fail.
        # But we are filtering for MP4/Text in the trigger, so this should be fine.
        
        with open(temp_local_path, "wb") as fh:
            downloader = MediaIoBaseDownload(fh, request_drive)
            done = False
            while done is False:
                status, done = downloader.next_chunk()
                # print(f"Download {int(status.progress() * 100)}%.")

        # 4. Upload to GCS
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(file_name)
        
        blob.upload_from_filename(temp_local_path, content_type=mime_type)
        os.remove(temp_local_path)
        
        gcs_uri = f"gs://{bucket_name}/{file_name}"
        print(f"Upload complete: {gcs_uri}")

        return {"gcsUri": gcs_uri}, 200

    except Exception as e:
        print(f"Error: {e}")
        return {"error": str(e)}, 500