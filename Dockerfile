# DayPlay — SF Bay Area Local Intelligence (Apify Actor)
FROM apify/actor-node:22

# Copy manifests first for Docker layer caching
COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "NPM install done."

# Copy source
COPY --chown=myuser:myuser . ./

CMD npm run start:prod --silent
