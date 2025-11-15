from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
import uuid
from datetime import datetime, timezone
from ibm_watsonx_ai import APIClient
from ibm_watsonx_ai import Credentials
from ibm_watsonx_ai.foundation_models import ModelInference
import httpx
import re
import json
import asyncio


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection (optional)
# If MONGO_URL is not provided the server will fall back to an in-memory store
mongo_url = os.environ.get('MONGO_URL')
if mongo_url:
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ.get('DB_NAME', 'test')]
else:
    client = None
    db = None
    # simple in-memory store for status checks (thread-safe with an async Lock)
    from asyncio import Lock as _AsyncLock
    _status_checks_store: list[dict] = []
    _status_checks_lock = _AsyncLock()

# Watson X AI setup
watsonx_api_key = os.environ.get('WATSONX_API_KEY')
project_id = os.environ.get('PROJECT_ID')
service_url = os.environ.get('WATSONX_SERVICE_URL')

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

class ChatRequest(BaseModel):
    message: str
    use_web_search: Optional[bool] = False

class ChatResponse(BaseModel):
    response: str
    thinking: Optional[str] = None
    sources: Optional[List[str]] = None
    web_sources: Optional[List[dict]] = None
    web_searched: bool = False

# Wellness system prompt
WELLNESS_PROMPT = """You are a helpful wellness assistant providing general health guidance.

Guidelines:
- Provide guidance on: nutrition, exercise, sleep, stress management, hydration, and routine checkups
- Base responses on trusted sources: CDC, WHO, NIH, Mayo Clinic, USDA
- Be short, clear, friendly, and non-judgmental
- NEVER diagnose, predict disease, or ask for personal medical details
- Do not store or reference user-identifying or health data
- If question is outside general wellness, say: "Please consult a healthcare professional"

Provide your response in this format:
[THINKING]
Your reasoning process and how you'll approach this question
[/THINKING]

[RESPONSE]
Your actual clear, friendly answer here
[/RESPONSE]

[SOURCES]
List the relevant sources: CDC, WHO, NIH, Mayo Clinic, etc.
[/SOURCES]

User question: {question}
"""

@api_router.get("/")
async def root():
    return {"message": "Wellness Assistant API"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)
    
    doc = status_obj.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    # Persist to MongoDB if configured, otherwise to the in-memory store
    if db:
        _ = await db.status_checks.insert_one(doc)
    else:
        async with _status_checks_lock:
            # store a shallow copy to avoid accidental mutation
            _status_checks_store.append(dict(doc))

    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    if db:
        status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
        for check in status_checks:
            if isinstance(check.get('timestamp'), str):
                check['timestamp'] = datetime.fromisoformat(check['timestamp'])
        return status_checks
    else:
        # return the in-memory store contents
        async with _status_checks_lock:
            # return parsed copies converting ISO timestamps back to datetimes
            result = []
            for check in list(_status_checks_store):
                c = dict(check)
                if isinstance(c.get('timestamp'), str):
                    c['timestamp'] = datetime.fromisoformat(c['timestamp'])
                result.append(c)
            return result

async def search_health_info(query: str) -> dict:
    """Search web for health information from trusted sources"""
    try:
        search_query = f"{query} site:cdc.gov OR site:who.int OR site:nih.gov OR site:mayoclinic.org OR site:health.harvard.edu"
        
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": search_query},
                headers={"User-Agent": "Mozilla/5.0"}
            )
            
            if response.status_code == 200:
                # Parse for sources
                web_sources = []
                if "cdc.gov" in response.text.lower():
                    web_sources.append({"name": "CDC", "url": "cdc.gov"})
                if "who.int" in response.text.lower():
                    web_sources.append({"name": "WHO", "url": "who.int"})
                if "nih.gov" in response.text.lower():
                    web_sources.append({"name": "NIH", "url": "nih.gov"})
                if "mayoclinic.org" in response.text.lower():
                    web_sources.append({"name": "Mayo Clinic", "url": "mayoclinic.org"})
                
                return {
                    "context": response.text[:500],
                    "sources": web_sources
                }
            return {"context": "", "sources": []}
    except Exception as e:
        logging.error(f"Web search error: {e}")
        return {"context": "", "sources": []}

def parse_structured_response(text: str) -> dict:
    """Parse the structured response from Watson"""
    thinking = ""
    response = ""
    sources = []
    
    # Extract thinking
    thinking_match = re.search(r'\[THINKING\](.*?)\[/THINKING\]', text, re.DOTALL | re.IGNORECASE)
    if thinking_match:
        thinking = thinking_match.group(1).strip()
    
    # Extract response
    response_match = re.search(r'\[RESPONSE\](.*?)\[/RESPONSE\]', text, re.DOTALL | re.IGNORECASE)
    if response_match:
        response = response_match.group(1).strip()
    else:
        # If no structured format, use the whole text as response
        if thinking:
            response = re.sub(r'\[THINKING\].*?\[/THINKING\]', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
        else:
            response = text.strip()
    
    # Extract sources
    sources_match = re.search(r'\[SOURCES\](.*?)\[/SOURCES\]', text, re.DOTALL | re.IGNORECASE)
    if sources_match:
        sources_text = sources_match.group(1).strip()
        for source in ['CDC', 'WHO', 'NIH', 'Mayo Clinic', 'USDA', 'Harvard Health']:
            if source in sources_text:
                sources.append(source)
    else:
        for source in ['CDC', 'WHO', 'NIH', 'Mayo Clinic', 'USDA']:
            if source in text:
                sources.append(source)
    
    # Clean up response
    response = re.sub(r'\[SOURCES\].*?\[/SOURCES\]', '', response, flags=re.DOTALL | re.IGNORECASE).strip()
    response = re.sub(r'Sources?:.*$', '', response, flags=re.MULTILINE).strip()
    
    return {
        "thinking": thinking if thinking else None,
        "response": response,
        "sources": sources if sources else None
    }

async def stream_response_generator(full_text: str, thinking_text: str = None, sources: list = None, web_sources: list = None, web_searched: bool = False):
    """Generate streaming response with simulated typing effect"""
    
    # Stream thinking first if available
    if thinking_text:
        yield f"data: {json.dumps({'type': 'thinking_start'})}\n\n"
        await asyncio.sleep(0.1)
        
        # Stream thinking word by word
        words = thinking_text.split()
        for i, word in enumerate(words):
            chunk = word + (' ' if i < len(words) - 1 else '')
            yield f"data: {json.dumps({'type': 'thinking', 'content': chunk})}\n\n"
            await asyncio.sleep(0.03)  # Faster streaming for thinking
        
        yield f"data: {json.dumps({'type': 'thinking_end'})}\n\n"
        await asyncio.sleep(0.2)
    
    # Stream main response
    yield f"data: {json.dumps({'type': 'response_start'})}\n\n"
    await asyncio.sleep(0.1)
    
    words = full_text.split()
    for i, word in enumerate(words):
        chunk = word + (' ' if i < len(words) - 1 else '')
        yield f"data: {json.dumps({'type': 'response', 'content': chunk})}\n\n"
        await asyncio.sleep(0.05)  # Typing speed
    
    yield f"data: {json.dumps({'type': 'response_end'})}\n\n"
    
    # Send metadata at the end
    metadata = {
        'type': 'metadata',
        'sources': sources,
        'web_sources': web_sources,
        'web_searched': web_searched
    }
    yield f"data: {json.dumps(metadata)}\n\n"
    
    yield f"data: {json.dumps({'type': 'done'})}\n\n"

@api_router.post("/chat/stream")
async def chat_with_watson_stream(request: ChatRequest):
    try:
        # Optionally enhance with web search
        web_search_data = None
        web_searched = False
        
        if request.use_web_search:
            web_search_data = await search_health_info(request.message)
            web_searched = True
        
        # Prepare prompt
        full_prompt = WELLNESS_PROMPT.format(question=request.message)
        if web_search_data and web_search_data.get("context"):
            full_prompt += f"\n\nAdditional web context: {web_search_data['context']}"
        
        # Initialize Watson X AI
        credentials = Credentials(
            api_key=watsonx_api_key,
            url=service_url
        )
        
        watsonx_client = APIClient(credentials)
        
        model = ModelInference(
            model_id="openai/gpt-oss-120b",
            api_client=watsonx_client,
            project_id=project_id,
            params={
                "max_new_tokens": 700,
                "temperature": 0.7
            }
        )
        
        # Generate full response (Watson doesn't support native streaming for this model)
        generated_response = model.generate_text(prompt=full_prompt)
        
        # Parse the response
        parsed = parse_structured_response(generated_response)
        
        # Return streaming response
        return StreamingResponse(
            stream_response_generator(
                full_text=parsed["response"],
                thinking_text=parsed["thinking"],
                sources=parsed["sources"],
                web_sources=web_search_data.get("sources") if web_search_data else None,
                web_searched=web_searched
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
    
    except Exception as e:
        logging.error(f"Error in Watson chat stream: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error generating response: {str(e)}")

@api_router.get("/wellness-topics")
async def get_wellness_topics():
    return {
        "topics": [
            {"id": "nutrition", "label": "Nutrition", "icon": "apple"},
            {"id": "exercise", "label": "Exercise", "icon": "activity"},
            {"id": "sleep", "label": "Sleep", "icon": "moon"},
            {"id": "stress", "label": "Stress", "icon": "heart"},
            {"id": "hydration", "label": "Hydration", "icon": "droplet"},
            {"id": "checkup", "label": "Check-ups", "icon": "clipboard"}
        ]
    }

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    if client:
        client.close()