const fs = require('fs-extra')
const crypto = require('crypto')
const path = require('path')

class SubresourceIntegrityInjector {
  computeSRI (filePath, algorithm = 'sha384') {
    const fileBuffer = fs.readFileSync(filePath)
    const hashSum = crypto.createHash(algorithm)
    hashSum.update(fileBuffer)

    const base64Hash = hashSum.digest('base64')
    return `${algorithm}-${base64Hash}`
  }

  updateHtmlTag (match, outputDir, algorithm, htmlContent) {
    const tagName = match[1]
    const attributesBefore = match[2]
    const urlType = match[3]
    const url = match[4]
    const attributesAfter = match[5]

    if (!url.startsWith('http')) {
      const resourceFilePath = path.join(outputDir, url)

      if (fs.existsSync(resourceFilePath)) {
        const sriHash = this.computeSRI(resourceFilePath, algorithm)
        const newTag = `<${tagName}${attributesBefore}${urlType}="${url}" integrity="${sriHash}" crossorigin="anonymous"${attributesAfter}/>`

        htmlContent = htmlContent.replace(match[0], newTag)
      }
    }
    return htmlContent
  }

  insertSRIInHTML (outputDir, algorithm = 'sha384') {
    const p = new Promise((resolve, reject) => {

      const htmlFilePath = path.join(outputDir, 'index.html')

      if (!fs.existsSync(htmlFilePath)) {
        const errorText = 'index.html not found in output directory'
        //console.error(errorText);
        reject(errorText)
        return
      }

      let htmlContent = fs.readFileSync(htmlFilePath, 'utf8')

      // Regex to match link, script, and img tags
      const regex = /<(link|script|img)([^>]*)(href|src)="([^"]+)"([^>]*)>/g
      let match

      while ((match = regex.exec(htmlContent)) !== null) {
        htmlContent = this.updateHtmlTag(match, outputDir, algorithm, htmlContent)
      }
      try {
        fs.writeFileSync(htmlFilePath, htmlContent)
        resolve()
      } catch (e) {
        reject(e)
      }
    })
    return p
  }

}

module.exports = SubresourceIntegrityInjector
