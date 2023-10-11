const { InfluxDB, Point } = require('@influxdata/influxdb-client')

/*
    Required environmental variables:
     - INFLUXDB_URL
     - INFLUXDB_TOKEN
     - INFLUXDB_ORGANIZATION
     - INFLUXDB_BUCKET
*/

const client = new InfluxDB({ 
    url: process.env.INFLUXDB_URL, 
    token: process.env.INFLUXDB_TOKEN 
});

async function writeMeasurements(_data, _context) 
{
    try {
        let writeClient = client.getWriteApi(process.env.INFLUXDB_ORGANIZATION, process.env.INFLUXDB_BUCKET, 'ns');

        for (let item of _data) {
            let point = new Point(item.measurement);
            point.timestamp(item.timestamp);

            for (let tag of item.tags)
                point.tag(tag.name, tag.value)

            for (let field of item.fields) {
                if (field.value === null) continue;
                switch (field.type) {
                case 'float':
                    point.floatField(field.name, field.value);
                    break;
                case 'int':
                    point.intField(field.name, field.value);
                    break;
                }
            }
            writeClient.writePoint(point);
        }

        await writeClient.flush();
        await writeClient.close();
    } 
    catch (e) 
    {
        throw new Error(e);
    }
}


module.exports = { writeMeasurements }
