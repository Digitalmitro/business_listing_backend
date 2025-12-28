require('dotenv').config();
const mongoose = require('mongoose');
const emailWorker = require('./workers/emailWorker');
const welcomeWorker = require('./workers/welcomeWorker');
const purchaseWorker = require('./workers/purchaseWorker');

async function startWorker() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Initialize the workers (BullMQ starts processing jobs automatically)
    console.log('Email workers started: email-campaigns, welcome-email, purchase-email');

    // Keep the process alive to handle BullMQ jobs
    process.on('SIGINT', async () => {
      console.log('Shutting down email workers...');
      await emailWorker.close();
      await welcomeWorker.close();
      await purchaseWorker.close();
      await mongoose.connection.close();
      console.log('Workers and MongoDB connection closed');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('Shutting down email workers...');
      await emailWorker.close();
      await welcomeWorker.close();
      await purchaseWorker.close();
      await mongoose.connection.close();
      console.log('Workers and MongoDB connection closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('Error starting worker:', error);
    process.exit(1);
  }
}

startWorker();