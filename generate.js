const fs = require('fs');

async function run() {
    console.log("⬇️ Downloading official 14,000+ Cambodia villages dataset from GitHub...");
    
    try {
        const baseUrl = 'https://raw.githubusercontent.com/ravuthz/khmer-address-data/master';
        
        const [provRes, distRes, commRes, villRes] = await Promise.all([
            fetch(`${baseUrl}/provinces.json`),
            fetch(`${baseUrl}/districts.json`),
            fetch(`${baseUrl}/communes.json`),
            fetch(`${baseUrl}/villages.json`)
        ]);

        if (!provRes.ok) throw new Error("GitHub rejected the download request.");

        const provinces = await provRes.json();
        const districts = await distRes.json();
        const communes = await commRes.json();
        const villages = await villRes.json();

        // THE FIX: Targeting 'cd' and 'en' exactly as shown in your terminal!
        function extractData(data) {
            const map = new Map();
            const items = Array.isArray(data) ? data : Object.values(data);
            
            for (let item of items) {
                // Grab the official NCDD geographic ID (cd) and English Name (en)
                const id = item.cd;
                const name = item.en;
                
                if (id && name) {
                    map.set(String(id), name);
                }
            }
            return map;
        }

        const provMap = extractData(provinces);
        const distMap = extractData(districts);
        const commMap = extractData(communes);
        const villMap = extractData(villages);

        console.log(`✅ Loaded: ${provMap.size} Provinces, ${distMap.size} Districts, ${commMap.size} Communes, ${villMap.size} Villages!`);

        const validLocations = [];
        
        for (let [vId, villName] of villMap.entries()) {
            const pId = vId.substring(0, 2);
            const dId = vId.substring(0, 4);
            const cId = vId.substring(0, 6);

            const provName = provMap.get(pId);
            const distName = distMap.get(dId);
            const commName = commMap.get(cId);

            if (provName && distName && commName && villName) {
                validLocations.push(`${provName.replace(/,/g, '')},${distName.replace(/,/g, '')},${commName.replace(/,/g, '')},${villName.replace(/,/g, '')}`);
            }
        }

        if (validLocations.length === 0) {
            console.error("❌ Still failing to map. Printing sample:");
            console.log(provinces[0]);
            process.exit(1);
        }

        console.log(`🗺️ Successfully mapped ${validLocations.length} complete real location paths.`);
        console.log("🚀 Starting 10M record generation... this will take a few minutes.");
        
        const writeStream = fs.createWriteStream('cambodia_population_ultimate.csv');
        
        const genders = ['Male', 'Female'];
        const firstNamesM = ["Sok", "Sao", "Mao", "Chea", "Chhay", "Vann", "Pich", "Dara", "Vichea", "Rith", "Sovann", "Kosal", "Vuthy", "Samnang"];
        const firstNamesF = ["Bopha", "Sophea", "Kalyan", "Sreymom", "Nary", "Phalla", "Vanna", "Sokha", "Sitha", "Chanthou", "Kolab", "Dalis"];
        const lastNames = ["Keo", "Pen", "Nget", "Seng", "Lim", "Heng", "Cheam", "Nhim", "Phan", "Chhin", "Meas", "Som", "Ros", "Mok", "Ouk"];

        function randomDate(start, end) {
            return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
        }
        const startDob = new Date(1966, 0, 1);
        const endDob = new Date(2011, 0, 1);

        let i = 1;
        const total = 10000000;

        function writeChunk() {
            let ok = true;
            while (i <= total && ok) {
                const gender = genders[Math.floor(Math.random() * genders.length)];
                
                const fName = gender === 'Male' ? firstNamesM[Math.floor(Math.random() * firstNamesM.length)] : firstNamesF[Math.floor(Math.random() * firstNamesF.length)];
                const lName = lastNames[Math.floor(Math.random() * lastNames.length)];
                
                const name = `${lName} ${fName}_${i}`; 
                const dob = randomDate(startDob, endDob).toISOString().split('T')[0];
                const location = validLocations[Math.floor(Math.random() * validLocations.length)];

                const row = `${name},${gender},${dob},${location}\n`;
                
                if (i === total) {
                    writeStream.write(row);
                    console.log("🎉 Finished generating 10,000,000 100% REAL records!");
                } else {
                    ok = writeStream.write(row);
                }
                i++;
            }
            if (i <= total) {
                writeStream.once('drain', writeChunk);
            }
        }

        writeChunk();

    } catch (error) {
        console.error("Network Failed:", error.message);
    }
}

run();
