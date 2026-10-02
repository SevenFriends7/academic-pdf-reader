const fs = require('fs');

const storagePath = 'C:/Users/paroxetine/AppData/Roaming/Antigravity IDE/User/globalStorage/paper-reader.academic-pdf-reader/paper_d4aafa09d44ec2a8cce2468ec0ba2e77.json';
const data = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));

// Keys to remove (bad author / partial / polluted runs)
const badKeys = [
  '1_1_abbaaa1arndtlukasklaass',
  '1_2_1700switzerland',
  '1_3_anteriorcingulatecortexoper',
  '1_4_aorhabitualbehaviorsthatare',
  '1_6_thevpmaybecrucialfordmnre',
  '1_7_andimaging',
  '1_5_recentlyithasbeensuggested',
  '1_7_recentlyithasbeensuggested',
  '1_10_significance',
  '1_11_manyroutineinwardlyfocusedb',
  '1_12_authorcontributionsalkm',
  '1_13_theauthorsdeclarenocompeting',
  '1_14_thisarticlecontainssupporting',
  '1_3_dailyliferequirestransitions',
  '1_4_defaultmodenetworkventralp',
  '1_5_anteriorcingulatecortexoper',
  '1_6_aconsiderableamountofourtim',
  '1_8_thedmnencompassessignificant',
  '1_9_humanshasrevealedthatsomesu'
];

badKeys.forEach(k => {
  delete data.translations[k];
  if (data.sentenceTranslations) {
    delete data.sentenceTranslations[k];
  }
});

// Also remove any numeric index keys like '1_0', '1_1'
Object.keys(data.translations).forEach(k => {
  if (/^\d+_\d+$/.test(k)) {
    delete data.translations[k];
  }
});
if (data.sentenceTranslations) {
  Object.keys(data.sentenceTranslations).forEach(k => {
    if (/^\d+_\d+$/.test(k)) {
      delete data.sentenceTranslations[k];
    }
  });
}

// Clean up standard keys for Page 1
const cleanKeys = {
  '1_ventralpallidumregulatesthed': '腹侧苍白球调节默认模式网络并控制内源性与外源性导向行为之间的转换',
  '1_dailyliferequirestransitions': data.translations['1_1_dailyliferequirestransitions'],
  '1_defaultmodenetworkventralp': data.translations['1_2_defaultmodenetworkventralp'],
  '1_aconsiderableamountofourtim': data.translations['1_3_aconsiderableamountofourtim'],
  '1_recentlyithasbeensuggested': data.translations['1_4_recentlyithasbeensuggested'],
  '1_thedmnencompassessignificant': data.translations['1_5_thedmnencompassessignificant'],
  '1_significancemanyroutineinwar': data.translations['1_6_significancemanyroutineinwar']
};

Object.entries(cleanKeys).forEach(([k, v]) => {
  if (v) data.translations[k] = v;
});

fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf-8');
console.log('Cleaned storage successfully. Remaining keys:');
Object.keys(data.translations).forEach(k => {
  console.log(`  ${k}: ${data.translations[k].slice(0, 50)}...`);
});
