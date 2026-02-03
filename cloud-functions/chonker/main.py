import functions_framework
import re
import json
import unicodedata

@functions_framework.http
def split_document_by_section(request):
    """
    Splits document into a LIST of chunks (compatible with 'foreach' loops).
    Uses strict JSON sanitization to prevent Elasticsearch errors.
    """
    
    # 1. CORS & HEADERS
    if request.method == 'OPTIONS':
        return ('', 204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        })

    headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json' 
    }

    # 2. INPUT HANDLING
    try:
        full_text = ""
        content_type = request.headers.get('Content-Type', '')
        if 'application/json' in content_type:
            payload = request.get_json(silent=True)
            if payload and 'text' in payload:
                full_text = payload['text']
        
        if not full_text:
            full_text = request.get_data(as_text=True)

    except Exception as e:
        return (json.dumps({"error": str(e)}), 400, headers)

    if not full_text:
        return (json.dumps({"error": "Empty body"}), 400, headers)

    # 3. NORMALIZATION
    clean_text = unicodedata.normalize("NFC", full_text)
    clean_text = clean_text.replace('\r\n', '\n').replace('\r', '\n')
    
    # Strip Intro
    header_pattern = r'(?:^|\n)(### |#### |\*\*)'
    match = re.search(header_pattern, clean_text)
    if match:
        start_idx = match.start()
        if clean_text[start_idx] == '\n': start_idx += 1
        clean_text = clean_text[start_idx:]
    
    clean_text = "\n" + clean_text.strip()

    # 4. SPLITTING
    UNIQUE_DELIMITER = "|||SPLIT_HERE|||"
    if re.search(r'\n\s*### ', clean_text):
        clean_text = re.sub(r'\n\s*(### )', f'\n{UNIQUE_DELIMITER}\\1', clean_text)
    elif re.search(r'\n\s*#### ', clean_text):
        clean_text = re.sub(r'\n\s*(#### )', f'\n{UNIQUE_DELIMITER}\\1', clean_text)
    elif re.search(r'\n\s*\*\*(?:\d+\.|\(|Start:)', clean_text):
        clean_text = re.sub(r'\n\s*(\*\*(?:\d+\.|\(|Start:))', f'\n{UNIQUE_DELIMITER}\\1', clean_text)

    # 5. GENERATE LIST OUTPUT
    chunks = []
    for chunk in clean_text.split(UNIQUE_DELIMITER):
        chunk = chunk.strip()
        if chunk:
            chunks.append(chunk)

    # 6. RETURN JSON OBJECT (Compatible with your foreach loop)
    return (json.dumps({"chunks": chunks}, ensure_ascii=True), 200, headers)