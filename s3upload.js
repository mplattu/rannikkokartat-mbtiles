const Agent = require('agentkeepalive')
const sqlite3 = require('sqlite3')
const AWS = require('aws-sdk')
const _ = require('lodash')
const Bacon = require('baconjs')

const keepaliveAgent = new Agent.HttpsAgent({maxSockets: 50})

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_S3_ACCESSKEYID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_S3_REGION,
  params: {Bucket: process.env.AWS_S3_BUCKET},
  sslEnabled: true,
  httpOptions: {
    agent: keepaliveAgent,
    connectTimeout: 10000
  }
})

const s3_prefix = process.env.AWS_S3_PREFIX

function uploadFile({key, file}) {
  const params = {Key: key, Body: file, ACL: 'public-read'}
  const time = Date.now()
  return Bacon.fromBinder((sink) => {
    const upload = s3.upload(params)
    upload.send((error, data) => {
      if (error) {
        sink(new Bacon.Error({message: `Failed uploading file to aws, {key: ${key}`, error}))
      } else {
        sink(new Bacon.Next(true))
      }
      sink(new Bacon.End())
    })
    return () => new Bacon.End()
  })
}

function init(dbFile) {
  const db = new sqlite3.Database(dbFile)

  const result = Bacon.fromArray(_.range(5,16)).flatMapConcat(zoomLevel => {
    return fetchRows(zoomLevel)
    .flatMap(rows => Bacon.fromArray(rows))
    .flatMapConcat(row => {
      console.log(`Fetching zoom level ${zoomLevel}: row #${row}`)
      return fetchTilesForZoomLevelAndRow(zoomLevel, row)
        .flatMapConcat(files => Bacon.fromArray(_.map(files, (file, key) => ({file, key}))))
        .flatMapWithConcurrencyLimit(50, uploadFile)
    })
  })

  result.onValue(() => {})
  result.onError(e => console.error(e))
  result.onEnd(() => console.log('Done'))

  function fetchTilesForZoomLevelAndRow(zoomLevel, row) {
    const bus = new Bacon.Bus()
    const files = {}
    db.each('SELECT * FROM tiles WHERE zoom_level=? AND tile_row=?', [zoomLevel, row], (err, row) => {
      if (err) {
        console.error('Error ', err)
        return
      }
      const z = row.zoom_level
      const y = (1 << z) - 1 - row.tile_row
      const x = row.tile_column
      const key = s3_prefix+`${z}/${x}/${y}.png`
      files[key] = row.tile_data
    }, (err) => {
      bus.push(files)
      bus.end()
    })
    return bus
  }

  function fetchRows(zoomLevel) {
    const bus = new Bacon.Bus()
    const rows = []
    db.each('SELECT DISTINCT(tile_row) FROM tiles WHERE zoom_level=?', [zoomLevel], (err, row) => {
      rows.push(row.tile_row)
    }, (err) => {
      bus.push(rows)
      bus.end()
    })
    return bus
  }
}

if (process.argv[2]) {
	init(process.argv[2])
}
else {
	console.log("usage: s3upload.js file.mbtiles\n")
}
