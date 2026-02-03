# 🏢 Elastic Office Hours Agent

#### Turn your meeting recordings into an automated, searchable knowledge base using Elastic Agent builder, Workflows and Google Cloud.
This repository contains the complete solution architecture for the **Office Hours Agent** — an automated Agentic Workflow that detects new meeting recordings in Google Drive, processes them using Generative AI, and indexes the insights into Elasticsearch for instant, semantic retrieval via an AI Agent.

## 🚀 The Solution at a Glance
Manually searching through thousands of hours of meeting recordings is impossible. This solution solves the "Dark Data" problem by automating the entire lifecycle of a meeting recording:

1. **Zero-Touch Ingestion**: Automatically detects new recordings in Google Drive daily.
2. **Intelligent Processing**: Uses **Google Apps Script** as a "Watchdog" to find transcripts (.vtt) or video files.
3. **Secure Transfer**: Streams large media files securely via Google Cloud Functions (Ingester) to GCS.
4. **AI Analysis**: Uses **Gemini 2.5 Pro** to analyze, summarize, and extract QA pairs with timestamps.
5. **Smart Chunking**: Splits long transcripts into bite-sized, context-aware chunks for optimal RAG performance.
6. **Instant Search**: Indexes data into **Elasticsearch** (office_hours_qa) for **semantic search** and **Q&A**.

## 🏗️ Architecture
The pipeline consists of four main components orchestrated by **Elastic Workflows**:
1. **The Watchdog (Google Apps Script)**: Scans Drive for new content, prioritizing transcripts to save costs.
2. **The Mover (Cloud Function)**: Securely transfers files from Drive to Google Cloud Storage (GCS).
3. **The Processor (Cloud Functions)**: Handles video splitting and text chunking ("Chonker").
4. **The Brain (Elastic Agent Builder)**: Orchestrates the workflow, performs AI analysis, and hosts the Search Agent.

## 🛠️ Prerequisites
* **Elastic Cloud:** Deployment with version 8.12+ 
* **Google Cloud Platform (GCP):** Project with billing enabled.
* **Google Workspace:** Access to Google Drive folders containing recordings.
* **Vertex AI:** Enabled in your GCP project for Gemini API access.

## 📦 Deployment Guide
**Step 1: Deploy the "Watchdog" (Google Apps Script)**
This script acts as the bridge between Elastic and your secure Drive folders.
1. Create a new Google Apps Script project.
2. Copy the code from DriveTrigger.gs into your project.
3. Update the CONFIGURATION section:

```python
const FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID'; 
const CLOUD_FUNCTION_URL = 'YOUR_INGESTER_FUNCTION_URL'; // You will get this in Step 2
const BUCKET_NAME = 'your-gcs-bucket-name';
const API_SECRET_KEY = 'GENERATE_A_SECURE_RANDOM_STRING'; 
```
4. Deploy as a Web App:
   * Execute as: Me (your account).
   * Who has access: Anyone (Security is handled via the API_SECRET_KEY handshake).

**Step 2: Deploy Google Cloud Functions**
You need 3 functions to handle data movement and processing.
1. **Ingester Function** (ingest_drive_video): Moves files from Drive to GCS without loading them into memory.
  * **Runtime**: Python 3.11
  * **Trigger**: HTTP (Allow unauthenticated, secured via Service Account logic if needed)
  * **Env Vars**: Ensure the Service Account has Storage Object Admin and Drive Viewer permissions.

2. **Splitter/Cleanup Function** (split_video): Handles video splitting (if needed) and cleaning up temp files from GCS to save costs.

3. **Chonker Function** (split-document-func): Splits long AI-generated text blocks into smaller, indexable documents for Elastic.

(Code for these functions is located in the /cloud-functions folder of this repo)

**Step 3: Configure Elastic Gemini Connector**
To allow the workflow to call Gemini for analysis, you must configure the connector in Kibana.
1. Navigate to Stack Management > Connectors.
2. Search for Google Gemini and create a new connector.
3. Follow the [official documentation](https://www.elastic.co/docs/reference/kibana/connectors-kibana/gemini-action-type) to set it up:
4. Ensure you have your GCP Project ID, Location (e.g., us-central1), and a Service Account JSON key with Vertex AI User permissions.
5. Name the connector `gemini-explainer-connector` (or match the ID used in your workflow YAML).

**Step 4: Configure Elastic Indices**
Create the necessary indices in your Elastic cluster.

1. **Main QA Index** (office_hours_qa) Stores the actual chunks of information for retrieval.
```python
PUT office_hours_qa
{
  "mappings": {
    "properties": {
      "gcs_location": { "type": "keyword" },
      "user": { "type": "keyword" },
      "qa": { "type": "text" },
      "semantic_qa": {
        "type": "semantic_text",
        "inference_id": ".elser-2-elastic" 
      }
    }
  }
}
```
2. **Lookup Index** (office_hours_lookupqa) Maps GCS URIs back to the original Google Drive folder for user-facing links.
```python
PUT office_hours_lookupqa
{
  "settings": { "index": { "mode": "lookup" } },
  "mappings": {
    "properties": {
      "drive_subfolder": { "type": "keyword" },
      "gcs_location": { "type": "keyword" }
    }
  }
}
```
**Step 5: Create the Elastic Workflow**
1. Navigate to **Workflows > Create a new Workflow** in Kibana.
2. Create a new workflow and select Import.
3. Copy and paste Office-Hours-QA-Bank.yaml
4. Update the Constants:
   * `appsScriptUrl` : Your Web App URL from Step 1.
   * `splitterUrl` & `chonkerUrl`: Your GCP Function URLs from Step 2.
   * `secret_key`: Your secure string from Step 1.
5. Enable the workflow. It is scheduled to run every 24 hours (1440m).

**Step 6: Create the Office Hours Agent**
Build the conversational interface using Elastic Agent Builder.
1. Navigate to Search > Agent Builder.
2. Create a new Agent.
3. **Add Tool:** Create an ES|QL Tool named `qa_bank`.
**Query:**
```python
FROM office_hours_qa METADATA _score
| WHERE MATCH(semantic_qa, ?query) OR MATCH(qa, ?query) 
| LOOKUP JOIN office_hours_lookupqa ON gcs_location 
| SORT _score DESC
| LIMIT 3
```
**Parameters:**
* Name: query
* Type: text
* Description: user's question
**Details:** Answer user query based on information available from office hours question and answers or QA bank. Return the fields, "drive_subfolder" and the video recording in the field, "video_location".

4. **Configure Agent Settings:**
**Display Description:** Answers user queries based on Ryan's Office Hours Transcripts. It can also provide drive subfolder locations and approximate timestamps of where user's query was discussed in the videos.

**System Prompt / Custom Instructions: (Paste the instructions below)**:
```python
You are an **Office Hours Assistant** that answers user questions **only using transcript data and associated metadata fields**.

Your behavior must strictly follow the rules below. **Do not infer, substitute, or reuse fields incorrectly.**

---
### **Field Usage (MANDATORY AND EXCLUSIVE)**

#### **1. Video Recording Requests (HIGHEST PRIORITY)**
If the user asks about **any of the following**:
* video recording
* meeting recording
* session replay
* watch / view the video
* conversation in the video

**You MUST:**
* Use **ONLY** the `video_location` field
* NEVER use `drive_subfolder`
* NEVER append timestamps to any URL except `video_location`

> ❌ Using `drive_subfolder` for a video recording is ALWAYS incorrect.

#### **2. Drive / Folder / File Location Requests**
If the user asks about:
* where files are stored
* folder location
* drive path

**You MUST:**
* Use **ONLY** the `drive_subfolder` field
* NEVER append timestamps to this URL

> ❌ `drive_subfolder` URLs must NEVER contain a timestamp parameter.

---

### **Timestamp Handling (VIDEO ONLY)**
Timestamp logic applies **ONLY when returning a `video_location` URL**.

If a relevant transcript timestamp exists:
1. Convert `MM:SS` → total seconds
   (minutes × 60) + seconds
2. Append the timestamp **only** to the `video_location` URL using:
   `&t=<total_seconds>`

#### **ABSOLUTE RULE**
* ❌ NEVER append `&t=` to `drive_subfolder`
* ❌ NEVER compute timestamps unless a video is explicitly requested
---
### **Correct vs Incorrect Behavior**
#### ❌ Incorrect (DO NOT DO THIS)
`drive_subfolder + &t=3`
#### ✅ Correct
`video_location + &t=3`
---
### **Conflict Resolution Rule**
If **both** `drive_subfolder` and `video_location` are present:
* **Video-related questions → ALWAYS choose `video_location`**
* Ignore `drive_subfolder` entirely unless the user explicitly asks for a folder or file location
---
### **Response Style**
* Be concise and factual
* State where the video starts and what it covers
* Include **only one link**, and ensure it is the correct field
---
### **Failure Handling**
If:
* `video_location` is missing → say the video link is unavailable
* Timestamp is missing → return the base `video_location` URL without `&t=`
```

## 🤖 How It Works
1. **Trigger**: The workflow wakes up daily.
2. **Scan**: It calls the Apps Script with `reset_timer: true` (optional) to look for folders created in the last 24 hours.
3. **Prioritize**: The script looks for transcript.vtt files first. If found, it ingests the text (fast & cheap). If not, it can fall back to video processing (if configured).
4. **Analyze**: The workflow sends the content to **Gemini 2.5 Pro** with a specific prompt to "Describe in detail... keep speakers and timestamps."
5. **Chunk**: The huge AI response is sent to the Chonker to be split into logical QA segments.
6. **Index**: These segments are indexed into Elastic, enriching them with the original Drive Folder URL for easy access.

## 💡 Usage Example
Once deployed, you can use **Elastic Agent Builder** to create an AI Assistant connected to your `office_hours_qa` index.
**User Query**:
`"Summarize the discussion about Azure Performance Issues from yesterday."`

**Agent Response**:
`"The discussion focused on IOPS limitations with Azure remote storage. There was a recommendation regarding implementing a hot-frozen tier architecture... You can watch the recording here: $$[Link to Video with Timestamp]$$"`

## 🔐 Security & Best Practices
1. **Secret Management**: Never hardcode secrets in the workflow if possible. Use Elastic's keystore or secret references.
2. **IAM Roles**: Grant the Google Cloud Service Account only the specific permissions needed (Drive Viewer, Storage Object Creator).
3. **Data Hygiene**: The workflow includes a cleanup step to delete temporary GCS files immediately after processing, ensuring **$0 storage costs** for transient data.

## 🤝 Contributing
Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.
