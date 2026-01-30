# office-hours-agent

Answers user queries based on Office Hours Transcripts. It can also provide drive subfolder locations and approximate timestamps of where user's query was discussed in the videos.

This requires 2 indices to be created:
PUT office_hours_lookupqa
{
    "settings": {
        "index": {
            "mode": "lookup"
        }
    },
      "mappings": {
      "properties": {
            "drive_subfolder": {
                "type": "keyword"
            },
                "video_location": {
                "type": "keyword"
            },
            "gcs_location": {
                "type": "keyword"
            }
      }
      }
}

PUT office_hours_qa
PUT office_hours_qa/_mapping
{
  "properties": {
    "gcs_location": {
      "type": "keyword"
    },
    "user": {
      "type": "keyword"
    },
    "qa": {
      "type": "text",
      "fields": {
        "keyword": {
          "type": "keyword",
          "ignore_above": 256
        }
      }
    },
    "semantic_qa": {
      "type": "semantic_text",
      "inference_id": ".elser-2-elastic",
      "model_settings": {
        "service": "elastic",
        "task_type": "sparse_embedding"
      }
    }
  }
}
