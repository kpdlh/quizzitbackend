require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { PDFDocument } = require('pdf-lib');
const { fromPath } = require('pdf2pic');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase credentials in .env");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI Client
const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
    console.error("Missing OpenAI API key in .env");
    process.exit(1);
}
const openai = new OpenAI({ apiKey: openaiKey });

async function processQuizzes() {
    console.log("Starting background worker...");
    let totalGptCost = 0;

    // 1. Fetch all quizzes
    const { data: quizzes, error: fetchError } = await supabase
        .from('quizz')
        .select('*');

    if (fetchError) {
        console.error("Error fetching quizzes:", fetchError);
        return;
    }

    if (!quizzes || quizzes.length === 0) {
        console.log("No quizzes found.");
        return;
    }

    console.log(`Found ${quizzes.length} quizzes. Processing...`);

    for (const quiz of quizzes) {
        console.log(`\n--- Processing Quiz ID: ${quiz.id} ---`);
        if (!quiz.filepath) {
            console.log("No filepath for quiz, skipping.");
            continue;
        }

        try {
            // 2. Download the PDF from Supabase Storage
            const bucketName = 'files';

            let storagePath = quiz.filepath;

            console.log(`Downloading PDF from bucket '${bucketName}', path '${storagePath}'...`);
            const { data: pdfData, error: downloadError } = await supabase.storage
                .from(bucketName)
                .download(storagePath);

            if (downloadError) {
                console.error("Error downloading PDF:", downloadError);
                continue;
            }

            const tempDir = os.tmpdir();
            const tempPdfPath = path.join(tempDir, `${quiz.id}.pdf`);

            // Save PDF locally
            const buffer = Buffer.from(await pdfData.arrayBuffer());
            fs.writeFileSync(tempPdfPath, buffer);
            console.log(`PDF saved locally at ${tempPdfPath}`);

            // 3. Process 5 clusters of 3 random consecutive pages
            const pdfDoc = await PDFDocument.load(buffer);
            const totalPages = pdfDoc.getPageCount();
            console.log(`PDF has ${totalPages} pages.`);

            const storeAsImage = fromPath(tempPdfPath, {
                density: 150,
                saveFilename: `${quiz.id}_page`,
                savePath: tempDir,
                format: "png",
                width: 1024,
                height: 1448
            });

            const allImagesToDelete = [];
            let generatedQuestions = [];
            const usedPages = new Set(); // Keep track of pages already used to avoid repeats

            for (let cluster = 1; cluster <= 5; cluster++) {
                console.log(`\n--- Processing Cluster ${cluster}/5 ---`);
                let startPage = 1;
                let endPage = 3;

                // Random start page avoiding out of bounds and duplicates
                if (totalPages > 3) {
                    let attempts = 0;
                    let validCluster = false;

                    while (!validCluster && attempts < 100) {
                        startPage = Math.floor(Math.random() * (totalPages - 2)) + 1;
                        endPage = startPage + 2;

                        // Check if any page in this cluster is already used
                        if (!usedPages.has(startPage) && !usedPages.has(startPage + 1) && !usedPages.has(startPage + 2)) {
                            validCluster = true;
                        }
                        attempts++;
                    }

                    // If we couldn't find a completely non-overlapping cluster (e.g. document too short), just try to make the start page unique
                    if (!validCluster) {
                        attempts = 0;
                        do {
                            startPage = Math.floor(Math.random() * (totalPages - 2)) + 1;
                            endPage = startPage + 2;
                            attempts++;
                        } while (usedPages.has(startPage) && attempts < 50);
                    }

                    // Mark these pages as used
                    for (let p = startPage; p <= endPage; p++) {
                        usedPages.add(p);
                    }
                } else {
                    endPage = totalPages;
                }

                const pagesToExtract = [];
                for (let i = startPage; i <= endPage; i++) {
                    pagesToExtract.push(i);
                }

                console.log(`Cluster ${cluster}: Selected pages ${pagesToExtract.join(', ')}`);

                const base64Images = [];
                for (const pageNum of pagesToExtract) {
                    console.log(`Converting page ${pageNum} to image...`);
                    const result = await storeAsImage(pageNum, { base64: true });

                    if (result && result.base64) {
                        base64Images.push(result.base64);
                    } else if (result && result.path) {
                        // fallback if base64 is not automatically supplied
                        const base64 = fs.readFileSync(result.path, { encoding: 'base64' });
                        base64Images.push(base64);
                    }

                    if (result && result.path) {
                        allImagesToDelete.push(result.path);
                    }
                }

                // 5. Build prompt for GPT-4o
                console.log(`Cluster ${cluster}: Sending images to OpenAI GPT-4o for question generation...`);

                const imageContents = base64Images.map(base64 => ({
                    type: "image_url",
                    image_url: {
                        url: `data:image/png;base64,${base64}`,
                        detail: "high"
                    }
                }));

                const systemPrompt = `You are a helpful assistant that generates multiple-choice questions from document pages. For students to prepare for their quizzes. Do not reference to any particular image, understand the pages and ask questions based on the content of the pages.
You MUST output your response strictly as a JSON array of 2 objects, with NO markdown formatting, NO \`\`\`json block, just the raw JSON array.
Each object must have the exact following structure:
{
  "Question": "The text of the question",
  "answers": [
    "Option 1",
    "Option 2",
    "Option 3",
    "Option 4"
  ],
  "correct_answer": 0 // Integer index of the correct answer (0, 1, 2, or 3)
}
CRITICAL INSTRUCTION: The 'correct_answer' field should contain only the integer index of the correct option (0, 1, 2, or 3).`;

                const response = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: systemPrompt },
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Here are 3 consecutive pages from a document. Create 2 multiple-choice questions based on the content of these pages." },
                                ...imageContents
                            ]
                        }
                    ],
                    max_tokens: 1500,
                });

                if (response.usage) {
                    const promptTokens = response.usage.prompt_tokens;
                    const completionTokens = response.usage.completion_tokens;
                    const cost = ((promptTokens / 1000000) * 2.50) + ((completionTokens / 1000000) * 10.00);
                    totalGptCost += cost;
                    console.log(`Cluster ${cluster} GPT-4o usage: ${promptTokens} prompt tokens, ${completionTokens} completion tokens. Estimated cost: $${cost.toFixed(4)}`);
                }

                let rawResponse = response.choices[0].message.content.trim();

                if (rawResponse.startsWith('```json')) {
                    rawResponse = rawResponse.replace(/^```json/, '').replace(/```$/, '').trim();
                } else if (rawResponse.startsWith('```')) {
                    rawResponse = rawResponse.replace(/^```/, '').replace(/```$/, '').trim();
                }

                try {
                    const questions = JSON.parse(rawResponse);
                    if (Array.isArray(questions)) {
                        generatedQuestions.push(...questions);
                    } else {
                        console.error(`Cluster ${cluster}: Expected an array, got something else.`);
                    }
                } catch (e) {
                    console.error(`Cluster ${cluster}: Failed to parse JSON from OpenAI response:`, rawResponse);
                }
            }

            if (generatedQuestions.length === 0) {
                console.error("Failed to generate any questions from the clusters.");
                continue;
            }

            // 6. Save questions to Supabase
            console.log(`Saving ${generatedQuestions.length} total generated questions to Supabase...`);

            // Create a perfectly balanced pool of correct answer indices for the number of questions we have
            const targetDistribution = [];
            for (let i = 0; i < generatedQuestions.length; i++) {
                targetDistribution.push(i % 4);
            }

            // Shuffle the target distribution using Fisher-Yates
            for (let i = targetDistribution.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [targetDistribution[i], targetDistribution[j]] = [targetDistribution[j], targetDistribution[i]];
            }

            const recordsToInsert = generatedQuestions.map((q, index) => {
                // Guarantee true randomness of correct answer position programmatically
                const correctText = q.answers[q.correct_answer];
                let allAnswers = Array.isArray(q.answers) ? [...q.answers] : [];

                // Proceed with shuffle only if the LLM provided exactly 4 valid options + correct choice
                if (correctText !== undefined && allAnswers.length === 4 && allAnswers.every(ans => !!ans)) {
                    // Extract incorrect options and shuffle them
                    // Note: If duplicate text exists, filter might remove too many, so we remove exactly one instance of correctText
                    const correctIndex = q.correct_answer;
                    const incorrectAnswers = [...allAnswers.slice(0, correctIndex), ...allAnswers.slice(correctIndex + 1)];

                    for (let i = incorrectAnswers.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [incorrectAnswers[i], incorrectAnswers[j]] = [incorrectAnswers[j], incorrectAnswers[i]];
                    }

                    const assignedCorrectIndex = targetDistribution[index];
                    const newAnswers = new Array(4);
                    let incorrectIdx = 0;

                    for (let i = 0; i < 4; i++) {
                        if (i === assignedCorrectIndex) {
                            newAnswers[i] = correctText;
                        } else {
                            newAnswers[i] = incorrectAnswers[incorrectIdx++];
                        }
                    }

                    return {
                        quizzid: quiz.id,
                        Question: q.Question,
                        answers: newAnswers,
                        correct_answer: assignedCorrectIndex
                    };
                }

                // Fallback: Use exact responses from LLM if format is malformed
                return {
                    quizzid: quiz.id,
                    Question: q.Question,
                    answers: q.answers,
                    correct_answer: q.correct_answer
                };
            });

            const { error: insertError } = await supabase
                .from('question')
                .insert(recordsToInsert);

            if (insertError) {
                console.error("Error inserting questions into Supabase:", insertError);
            } else {
                console.log("Successfully saved questions for quiz", quiz.id);
            }

            // Cleanup temp files
            try {
                if (fs.existsSync(tempPdfPath)) {
                    fs.unlinkSync(tempPdfPath);
                }
                for (const imgPath of allImagesToDelete) {
                    if (fs.existsSync(imgPath)) {
                        fs.unlinkSync(imgPath);
                    }
                }
            } catch (cleanupErr) {
                console.error("Error during cleanup:", cleanupErr);
            }

        } catch (err) {
            console.error(`Error processing quiz ${quiz.id}:`, err);
        }
    }

    console.log(`Finished processing quizzes. Total GPT-4o API cost: $${totalGptCost.toFixed(4)}`);
}

// Run the script
processQuizzes().catch(err => {
    console.error("Unhandled top-level error:", err);
    process.exit(1);
});
