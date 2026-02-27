# Use a standard Debian-based Node image. 
# Debian (bullseye/bookworm) is much better than Alpine for PDF processing tools.
FROM node:20-bullseye-slim

# Install OS-level dependencies required by `pdf2pic`
# It relies heavily on GraphicsMagick and Ghostscript to process and convert PDF pages into images
RUN apt-get update && apt-get install -y \
    graphicsmagick \
    ghostscript \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker layer caching
COPY package*.json ./

# Install Node dependencies (using npm ci for predictable, clean installs if package-lock exists)
RUN npm install

# Copy the rest of the application files
COPY . .

# Command to execute the worker script
CMD ["node", "index.js"]
