const { TYPES, Connection, Request } = require('tedious');

/*
    Required environmental variables:
     - SQLSERVER_URL
     - SQLSERVER_USERNAME
     - SQLSERVER_PASSWORD
     - SQLSERVER_DATABASE
*/

async function getDeviceConfig(deveui) {
    return new Promise(async (resolve, reject) => {
        let config = null;

        /* Create SQL-Server connection */
        const connection = new Connection({
            server: process.env.SQLSERVER_URL,
            authentication: {
                type: 'default',
                options: {
                    userName: process.env.SQLSERVER_USERNAME,
                    password: process.env.SQLSERVER_PASSWORD,
                }
            },
            options: {
                database: process.env.SQLSERVER_DATABASE
            }
        });
        connection.connect(async (err) => {
            if (err) {
                reject(err);
            }

            /* Create Find Device by DevEUI query */
            const query = 'SELECT * from datasources WHERE SensorID=@deveui';
            const request = new Request(query, (err) => {
                if (err) {
                    reject(err);
                }
            });

            request.on('row', (columns) => {
                try {
                    let column = columns.find((x) => { return x.metadata.colName === 'config' });
                    if (column && column.value !== null) {
                        config = JSON.parse(column.value);
                    }
                } catch (error) {
                    reject(error);
                }

            });
            request.on('requestCompleted', () => {
                /* Resolve Promise and return tags array */
                connection.close();
                resolve(config);
            });

            /* Set query paramters */
            request.addParameter('deveui', TYPES.VarChar, deveui);

            /* Execute query */
            connection.execSql(request);

        });
    });

}

async function getDeviceTags(deveui) {
    return new Promise(async (resolve, reject) => {
        const tags = [];

        /* Create SQL-Server connection */
        const connection = new Connection({
            server: process.env.SQLSERVER_URL,
            authentication: {
                type: 'default',
                options: {
                    userName: process.env.SQLSERVER_USERNAME,
                    password: process.env.SQLSERVER_PASSWORD,
                }
            },
            options: {
                database: process.env.SQLSERVER_DATABASE
            }
        });
        connection.connect(async (err) => {
            if (err) {
                reject(err);
            }

            /* Create Find Device by DevEUI query */
            const query = 'SELECT * from datasources WHERE SensorID=@deveui';
            const request = new Request(query, (err) => {
                if (err) {
                    reject(err);
                }
            });

            request.on('row', (columns) => {
                const tagColumns = ['name'];

                /* Loop through row and add fields to tags array */
                for (let column of columns) {
                    if (tagColumns.includes(column.metadata.colName) && column.value !== null) {
                        tags.push({ name: column.metadata.colName, value: column.value });
                    }
                }
            });
            request.on('requestCompleted', () => {
                /* Resolve Promise and return tags array */
                connection.close();
                resolve(tags);
            });

            /* Set query paramters */
            request.addParameter('deveui', TYPES.VarChar, deveui);

            /* Execute query */
            connection.execSql(request);

        });
    });
}

async function updateMeasurementTags(measurements) {
    for (let measurement of measurements) {
        let newTags = [];
        const deveui = measurement.tags.find((x) => { return x.name === 'deveui' });
        if(deveui !== undefined)
        {
            try {
                newTags = await getDeviceTags(deveui.value);
            } catch (_error) {
                throw new Error(_error);
            }
    
            for (let tag of newTags) {
                measurement.tags.push(tag);
            }
        }
    }
}

module.exports = {
    getDeviceTags,
    getDeviceConfig,
    updateMeasurementTags
};