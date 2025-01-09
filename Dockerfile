# Use an official Node.js runtime as a parent image
FROM node:18

# Set the working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of your application code
COPY . .

# Optional: Override any default ENTRYPOINT from base image
ENTRYPOINT []

# Expose the port your app runs on
EXPOSE 5001

# Command to run your app
CMD ["npm", "start"]