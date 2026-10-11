# Built from the repository root (docker-compose.yml sets the context), because
# the API needs libs/phonemescape as well as backend/.
FROM python:3.12-slim

WORKDIR /srv

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# phonemescape: only its segment/feature modules are used server-side, which
# need numpy alone — skip its plotting and clustering dependencies.
COPY libs/phonemescape /srv/libs/phonemescape
RUN pip install --no-cache-dir --no-deps /srv/libs/phonemescape

COPY backend/app ./app

# The gazetteer (GeoNames cities500 + country/state tables) is baked in, so
# geocoding and NER place-linking never need the network at runtime.
ENV ISOGLOSS_GAZETTEER=/srv/gazetteer
RUN python -c "from app.datasets.geocode import fetch; fetch()"

ENV ISOGLOSS_DSN=postgresql://isogloss:isogloss@db:5432/isogloss \
    PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
