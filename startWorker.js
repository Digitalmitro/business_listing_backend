require('dotenv').config();
const mongoose = require('mongoose');
const emailWorker = require('./workers/emailWorker');

async function startWorker() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Initialize the email worker (BullMQ starts processing jobs automatically)
    console.log('Email worker started');

    // Keep the process alive to handle BullMQ jobs
    process.on('SIGINT', async () => {
      console.log('Shutting down email worker...');
      await emailWorker.close();
      await mongoose.connection.close();
      console.log('Worker and MongoDB connection closed');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('Shutting down email worker...');
      await emailWorker.close();
      await mongoose.connection.close();
      console.log('Worker and MongoDB connection closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('Error starting worker:', error);
    process.exit(1);
  }
}

startWorker();