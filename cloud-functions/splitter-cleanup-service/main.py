import functions_framework
from google.cloud import storage
from moviepy.video.io.ffmpeg_tools import ffmpeg_extract_subclip
from moviepy.editor import VideoFileClip
import os
import math
import tempfile

@functions_framework.http
def handle_video_tasks(request):
    try:
        request_json = request.get_json()
        action = request_json.get('action', 'split')

        # --- MODE 1: SPLIT VIDEO ---
        if action == 'split':
            if 'fileUri' not in request_json:
                return {"error": "Missing fileUri"}, 400
            
            file_uri = request_json['fileUri']
            
            # 1. Parse Bucket
            path_parts = file_uri.replace("gs://", "").split('/')
            bucket_name = path_parts[0]
            blob_name = '/'.join(path_parts[1:])
            
            storage_client = storage.Client()
            bucket = storage_client.bucket(bucket_name)
            blob = bucket.blob(blob_name)
            
            # 2. Download
            _, local_filename = tempfile.mkstemp(suffix=".mp4")
            blob.download_to_filename(local_filename)
            
            # 3. Get Metadata (Size & Duration)
            clip = VideoFileClip(local_filename)
            duration = clip.duration
            clip.close()
            
            file_size_bytes = os.path.getsize(local_filename)
            file_size_mb = file_size_bytes / (1024 * 1024)
            
            # 4. Determine Number of Parts based on Size
            if file_size_mb <= 200:
                num_parts = 10
            elif file_size_mb <= 300:
                num_parts = 20
            elif file_size_mb <= 400:
                num_parts = 30
            elif file_size_mb <= 500:
                num_parts = 40
            elif file_size_mb <= 600:
                num_parts = 50
            elif file_size_mb <= 700:
                num_parts = 60
            elif file_size_mb <= 800:
                num_parts = 70
            elif file_size_mb <= 900:
                num_parts = 80
            elif file_size_mb <= 1000: # 1GB
                num_parts = 90
            elif file_size_mb <= 1536: # 1.5GB
                num_parts = 150
            elif file_size_mb <= 2048: # 2GB
                num_parts = 200
            else: # > 2GB
                num_parts = 300

            # Calculate chunk duration based on the determined number of parts
            chunk_duration = duration / num_parts
            
            print(f"File Size: {file_size_mb:.2f}MB. Duration: {duration}s. Splitting into {num_parts} parts of {chunk_duration:.2f}s each.")
            
            generated_uris = []
            
            # 5. Split and Upload
            for i in range(num_parts):
                start = i * chunk_duration
                end = min((i + 1) * chunk_duration, duration)
                
                # Stop if we overshoot (though math above ensures we shouldn't)
                if start >= duration: break

                output_name = f"/tmp/part_{i+1}.mp4"
                target_blob_name = blob_name.replace(".mp4", f"_part{i+1}.mp4")
                
                ffmpeg_extract_subclip(local_filename, start, end, targetname=output_name)
                
                new_blob = bucket.blob(target_blob_name)
                new_blob.upload_from_filename(output_name)
                generated_uris.append(f"gs://{bucket_name}/{target_blob_name}")
                
                if os.path.exists(output_name):
                    os.remove(output_name)
            
            if os.path.exists(local_filename):
                os.remove(local_filename)

            return {"parts": generated_uris}, 200

        # --- MODE 2: CLEANUP ---
        elif action == 'cleanup':
            file_uri = request_json.get('fileUri')
            parts_to_delete = request_json.get('parts', [])
            
            storage_client = storage.Client()
            deleted_count = 0

            # Strategy A: Delete specific list if provided
            if parts_to_delete:
                for uri in parts_to_delete:
                    try:
                        path_parts = uri.replace("gs://", "").split('/')
                        bucket_name = path_parts[0]
                        blob_name = '/'.join(path_parts[1:])
                        bucket = storage_client.bucket(bucket_name)
                        bucket.blob(blob_name).delete()
                        deleted_count += 1
                        print(f"Deleted part: {blob_name}")
                    except Exception as e: 
                        print(f"Error deleting part {uri}: {e}")
            
            # Strategy B: Delete original file
            if file_uri:
                try:
                    path_parts = file_uri.replace("gs://", "").split('/')
                    bucket_name = path_parts[0]
                    blob_name = '/'.join(path_parts[1:])
                    bucket = storage_client.bucket(bucket_name)
                    bucket.blob(blob_name).delete()
                    deleted_count += 1
                    print(f"Deleted original: {blob_name}")
                except Exception as e:
                    print(f"Error deleting original {file_uri}: {e}")

            return {"message": f"Cleanup complete. Deleted {deleted_count} files."}, 200

    except Exception as e:
        print(f"Error: {e}")
        return {"error": str(e)}, 500