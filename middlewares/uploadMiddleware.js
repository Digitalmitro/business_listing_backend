const multerS3 = require('multer-s3');
const multer = require('multer')
const {s3} = require('../config/aws');

const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME,
    acl: 'public-read',
    key: (req, file, cb) => {
      
      const folder = req.body.folder || 'uploads';
      const uniqueName = `${folder}/${file.originalname}`;
      cb(null, uniqueName); // Save file with a unique name
    },
    contentType: multerS3.AUTO_CONTENT_TYPE
  })
});

module.exports = upload;
